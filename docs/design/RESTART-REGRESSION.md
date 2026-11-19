# 重启后回归（2026-11-19 15:13）

宿主 pid：38013 → 38013　结论：**全部通过**

| 项 | 结果 | 证据 |
|---|---|---|
| V3 bound 标记仍在 | ✅ | HTTP 200，threads=80，bound=80 |
| V1 force 后门已删（应 409） | ✅ | HTTP 409，reason=attached-readonly，目标=None |
| V2 游标到顶后仍推送（修前静默冻结） | ✅ | 初始 after=4000；after=4001（> 4000） |
