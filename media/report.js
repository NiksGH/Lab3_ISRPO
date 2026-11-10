(function () {
  const vscode = acquireVsCodeApi();
  const dataElement = document.getElementById('report-data');
  const data = JSON.parse(dataElement.textContent || '{}');
  const order = ['O(1)', 'O(log n)', 'O(log² n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(n³)', 'O(2ⁿ)', 'O(?)'];
  const counts = Object.fromEntries(order.map(key => [key, data.results.filter(item => item.complexity === key).length]));
  const recognizedEstimates = order.filter(key => key !== 'O(?)' && counts[key] > 0);
  const largestEstimate = recognizedEstimates[recognizedEstimates.length - 1] || (counts['O(?)'] ? 'O(?)' : '—');
  document.getElementById('summary').innerHTML =
    '<div class="card">Functions<strong>' + data.results.length + '</strong></div>' +
    '<div class="card">Files analyzed<strong>' + data.fileCount + '</strong></div>' +
    '<div class="card">Files with errors<strong>' + data.failures.length + '</strong></div>' +
    '<div class="card">Largest estimate<strong>' + largestEstimate + '</strong></div>';

  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  document.getElementById('rows').innerHTML = data.results.map((result, index) =>
    '<tr><td class="badge">' + escapeHtml(result.complexity) + '</td><td>' +
    '<button class="link" data-index="' + index + '">' + escapeHtml(result.name) + '</button><br>' +
    '<span class="muted">' + escapeHtml(result.file) + ':' + result.line + '</span></td><td>' +
    escapeHtml(result.explanation) + '</td></tr>'
  ).join('') || '<tr><td colspan="3">No function definitions found.</td></tr>';

  document.querySelectorAll('[data-index]').forEach(button => {
    button.addEventListener('click', () => {
      const result = data.results[Number(button.dataset.index)];
      vscode.postMessage({ file: result.file, line: result.line });
    });
  });

  const failures = document.getElementById('failures');
  if (data.failures.length) {
    failures.innerHTML = '<h2>Files that Clang could not analyze</h2><p class="error">' +
      data.failures.map(escapeHtml).join('\n\n') + '</p>';
  }

  // Illustrative curves compare growth shapes; they do not show measured execution time.
  const canvas = document.getElementById('chart');
  const context = canvas.getContext('2d');
  function drawChart() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const padding = { left: 42, right: 12, top: 16, bottom: 30 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    context.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-panel-border');
    context.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground');
    context.font = '11px sans-serif';
    context.lineWidth = 1;
    for (let index = 0; index <= 4; index++) {
      const y = padding.top + plotHeight * index / 4;
      context.beginPath(); context.moveTo(padding.left, y); context.lineTo(width - padding.right, y); context.stroke();
      context.fillText(String(100 - index * 25), 7, y + 4);
    }
    context.fillText('input size n', width / 2 - 25, height - 6);
    const curves = [
      [n => 8, '#3794ff'], [n => 12 * Math.log2(n + 1), '#4ec9b0'],
      [n => 8 * n, '#dcdcaa'], [n => 3 * n * Math.log2(n + 1), '#ce9178'],
      [n => 0.6 * n * n, '#f14c4c'], [n => 0.03 * Math.pow(2, n), '#c586c0']
    ];
    const max = 110;
    for (const [valueAt, color] of curves) {
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.beginPath();
      for (let n = 1; n <= 12; n++) {
        const x = padding.left + plotWidth * (n - 1) / 11;
        const y = padding.top + plotHeight * (1 - Math.min(valueAt(n), max) / max);
        if (n === 1) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
  }
  drawChart();
  window.addEventListener('resize', drawChart);
})();
