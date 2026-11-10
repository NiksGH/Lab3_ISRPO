#include <vector>

int sum(const std::vector<int>& values) {
    int result = 0;
    for (int value : values) result += value;
    return result;
}

void printPairs(int n) {
    for (int i = 0; i < n; ++i)
        for (int j = 0; j < n; ++j) (void)(i + j);
}

int binarySearchLike(const std::vector<int>& values, int target) {
    int left = 0, right = static_cast<int>(values.size());
    while (left < right) { int mid = left + (right - left) / 2; if (values[mid] < target) left = mid + 1; else right = mid; }
    return left;
}
