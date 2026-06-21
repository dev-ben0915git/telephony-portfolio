---
title: "Modem Crash 自动化归因"
date: "2025-03-28"
summary: "如何在不依赖昂贵工具链的前提下，每天自动解析 Modem 崩溃并给出归因？"
category: "crash-review"
tags: ["Modem", "Crash", "T32", "Automation"]
featured: true
---

## 目标

每天从测试台抓取 **80+** 个 Modem 崩溃 dump，人工分析耗时 **>2h**，且部分问题反复回归。

## 自动化流水线

```python
def signature(frames):
    return hashlib.sha1("|".join(frames[:8]).encode()).hexdigest()[:10]

def cluster(dumps):
    groups = {}
    for d in dumps:
        sig = signature(d.callstack)
        groups.setdefault(sig, []).append(d)
    return groups
```

1. **提取**：T32 CLI 拉取 PC/LR、栈与寄存器；
2. **归并**：函数签名聚类；
3. **映射**：匹配历史问题库，自动分类；
4. **报告**：按数量、机型、版本汇总。

## 数据

| 指标 | 人工 | 自动化 |
| ---- | ---- | ------ |
| 处理耗时 / dump | 8min | <40s |
| Top-N 召回 | 约 70% | ~96% |
| 回归阻断 | 人力 | CI 自动 |

## 收益

- Top3 反复回归问题 **彻底清零**；
- 测试团队整体分析效率 **+120%**。
