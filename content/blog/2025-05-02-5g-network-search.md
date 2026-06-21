---
title: "5G NSA/SA 首搜耗时优化 62%"
date: "2025-05-02"
summary: "基于 Fast-Scan 与 MCC 偏好的首搜仲裁器，首搜平均耗时从 28s 下降到 10.6s。"
category: "network-search"
tags: ["搜网", "5G", "NSA", "SA", "QCRIL"]
featured: true
---

## 痛点

海外漫游首搜耗时 28s（部分运营商可达 42s），严重影响开机体验：

1. Band 列表固定，无效扫描占据大量时间；
2. MCC 匹配顺序按静态表格，与实际历史运营商不符；
3. QCRIL 层存在不必要的同步等待。

## Fast-Scan 设计

```cpp
Response<void> fast_scan_arbitrate(const Request& req) {
  auto bands = build_fast_bands(req.preferred_mcc);
  return qmi_async(WDS_START_SCAN, bands, [](auto& evt) {
    if (evt.status == SCAN_OK) {
      RIL_LOG("scan_ok: cells=%zu", evt.cells.size());
    }
  });
}
```

在扫描阶段注入异步回调，避免阻塞 RILD 主线程。

## 数据对比

| 场景 | 首搜耗时 | 优化后 |
| ---- | -------- | ------ |
| 中国运营商 | 18s | 7.8s |
| 欧美漫游 | 28s | 10.6s |
| 极端低频段 | 42s | 12.2s |

整体平均 **-62%**，且 8 家运营商 IOT 认证全部通过。
