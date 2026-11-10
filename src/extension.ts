import * as vscode from 'vscode';
import * as path from 'node:path';
import { analyzeFile } from './clang';
import { FunctionResult, Growth, includeCallComplexity } from './analysis';

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('bigoInspector.analyzeProject', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      void vscode.window.showInformationMessage('Open a C++ project folder first.');
      return;
    }
    const root = folders[0].uri.fsPath;
    const clang = vscode.workspace.getConfiguration('bigoInspector').get<string>('clangPath', 'clang++');
    const standard = vscode.workspace.getConfiguration('bigoInspector').get<string>('standard', 'c++17');
    const files = await vscode.workspace.findFiles(
      '**/*.{cc,cpp,cxx,h,hh,hpp,hxx}', '**/{build,dist,out,node_modules,.git}/**'
    );
    if (!files.length) {
      void vscode.window.showInformationMessage('No C++ source files found in this workspace.');
      return;
    }

    const results: FunctionResult[] = [];
    const failures: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'BigO Inspector: analyzing C++ project', cancellable: false }, async progress => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i].fsPath;
        progress.report({ message: `${i + 1}/${files.length}: ${path.basename(file)}`, increment: 100 / files.length });
        try { results.push(...await analyzeFile(file, root, clang, standard)); }
        catch (error) { failures.push(`${path.relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
    includeCallComplexity(results);
    showReport(context, root, results, failures, files.length);
  });
  context.subscriptions.push(command);
}

function showReport(context: vscode.ExtensionContext, root: string, results: FunctionResult[], failures: string[], fileCount: number): void {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('bigoInspectorReport', 'BigO Inspector', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [media] });
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'report.js'));
  panel.webview.html = renderHtml(panel.webview, results, failures, fileCount, scriptUri);
  panel.webview.onDidReceiveMessage(async (message: { file?: string; line?: number }) => {
    if (!message.file) return;
    const uri = vscode.Uri.file(path.resolve(root, message.file));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const position = new vscode.Position(Math.max(0, (message.line ?? 1) - 1), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }, undefined, context.subscriptions);
}

function renderHtml(webview: vscode.Webview, results: FunctionResult[], failures: string[], fileCount: number, scriptUri: vscode.Uri): string {
  const safeJson = JSON.stringify({ results, failures, fileCount }).replace(/</g, '\\u003c').replace(/&/g, '\\u0026');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};"><title>BigO Inspector</title>
<style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1100px;margin:auto}h1{font-size:22px;margin:0 0 8px}.muted{color:var(--vscode-descriptionForeground)}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px 16px;min-width:100px}.card strong{display:block;font-size:20px;margin-top:4px}.chart{width:100%;height:240px;border:1px solid var(--vscode-panel-border);border-radius:6px;margin:10px 0 22px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top}th{color:var(--vscode-descriptionForeground)}button.link{background:none;border:0;color:var(--vscode-textLink-foreground);padding:0;font:inherit;cursor:pointer;text-align:left}.badge{font-family:var(--vscode-editor-font-family);font-size:14px}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.legend{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 18px}
</style><script type="application/json" id="report-data">${safeJson}</script></head><body><h1>BigO Inspector</h1><div class="muted">Clang AST heuristic report · ${fileCount} source file(s) scanned</div><div id="summary" class="summary"></div><h2>Growth comparison</h2><canvas id="chart" class="chart" aria-label="Estimated growth curves"></canvas><div class="legend"><span>Blue O(1)</span><span>Green O(log n)</span><span>Yellow O(n)</span><span>Orange O(n log n)</span><span>Red O(n²+)</span><span>Purple O(2ⁿ)</span></div><h2>Functions</h2><table><thead><tr><th>Estimate</th><th>Function</th><th>Explanation</th></tr></thead><tbody id="rows"></tbody></table><section id="failures"></section><script src="${scriptUri}"></script></body></html>`;
}

export function deactivate(): void { /* No background processes are kept alive. */ }
