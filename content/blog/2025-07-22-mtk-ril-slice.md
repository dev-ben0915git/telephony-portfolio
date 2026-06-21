---
title: "MTK RIL 双卡 PDP Context 调度"
date: "2025-07-22"
summary: "MTK 平台下自定义 Request，结合路由表与切片感知，降低双卡切换时延。"
category: "mtk-ril"
tags: ["MTK", "RIL", "PDP", "双卡", "切片"]
featured: true
---

## 场景

双卡 + 切片感知（S-NSSAI）下，用户在 APN 间切换时，原实现会先 deactivate 再 activate，导致**短暂的数据中断**。该时延在部分场景下可达 **1.2s**。

## 目标

- 让 PDP 切换时延 **<300ms**；
- 在 RIL 层保留足够的 QoS/DNN 路由信息；
- Framework 层调用风格保持不变。

## Java 层接口

```java
public interface SliceRouting {
  int activate(int slotId, SliceSpec spec);
  int deactivate(int slotId, int cid);
  List<SliceContext> list(int slotId);
}
```

## MTK RIL 自定义 Request

```c
static void onRequestSliceRoute(int slot, void *data, size_t len) {
  SliceRouteReq req = {0};
  if (!parse_slice_req(data, len, &req)) {
    RIL_onRequestComplete(RIL_E_GENERIC_FAILURE, NULL, 0);
    return;
  }
  int cid = pdp_pool_acquire(slot, req.dnn, PDP_HIGH_PRIO);
  if (cid < 0) {
    RIL_onRequestComplete(RIL_E_GENERIC_FAILURE, NULL, 0);
    return;
  }
  RIL_onRequestComplete(RIL_E_SUCCESS, &cid, sizeof(cid));
}
```

## 结果

- 切片切换时延从 1.2s 下降到 **280ms**；
- 多切片并发场景下吞吐稳定在理论值 **±5%**；
- Framework 无需改调用方式，仅新增 AIDL 接口给业务使用。
