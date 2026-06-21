---
title: "QCRIL 响应管道异步化实战"
date: "2025-08-10"
summary: "把 QCRIL 对 QMI 响应的阻塞处理改为异步管道，降低 RILD 主线程峰值时延，使 RIL 调用整体更可靠。"
category: "qcril"
tags: ["QCRIL", "QMI", "Android", "RILD", "异步"]
featured: true
---

## 背景

QCRIL 是高通 Android 平台上 Telephony 框架与 Modem 之间的中间层。早期代码里，
部分 QMI 请求在 RILD 主线程中使用同步等待机制，一旦 Modem 抖动，就会把
上层 TeleService 卡在 `waitForResult`，继而出现 ANR 或调用超时。

典型栈如下：

```
RIL.java#onRequest
  -> qcril_qmi_mmgsi_send_request
     -> qcril_qmi_sync_wait_for_response  // 15-800ms 不定
```

定位工具：**QXDM + RIL log**，通过筛选 `RIL_REQUEST_*` 与
`QMI_*_RSP` 的时间差，即得到每条 RIL 请求的真实耗时。

## 思路

1. **识别可异步化的请求**：对不要求即时返回数值的请求（如 `SET_PREFERRED_NETWORK_TYPE`）采用异步管道；
2. **保留关键同步点**：`REQUEST_GET_SIM_STATUS` 等早期读路径仍然使用同步，但增加超时与降级；
3. **事件通知**：通过 `UNSOL_RESPONSE_*` 向上层广播状态变化，避免轮询。

## C++ 管道实现片段

```cpp
// vendor/qcom/proprietary/qcril/hooks/async_pipe.h
namespace qcril {
struct pipe_task {
  int req_id;
  std::function<void(qcril::response&)> cb;
};

class async_pipe {
public:
  void push(pipe_task t) {
    std::lock_guard<std::mutex> lk(m_);
    q_.push_back(std::move(t));
    cv_.notify_one();
  }
  void run() {
    while (!stop_) {
      std::unique_lock<std::mutex> lk(m_);
      cv_.wait(lk, [&] { return !q_.empty() || stop_; });
      if (q_.empty()) continue;
      auto t = std::move(q_.front());
      q_.pop_front();
      lk.unlock();
      qmi_async_dispatch(t);
    }
  }
private:
  std::deque<pipe_task> q_;
  std::mutex m_;
  std::condition_variable cv_;
  std::atomic<bool> stop_{false};
};
} // namespace qcril
```

## 实测收益

| 指标 | 旧实现 | 新实现 | 变化 |
| ---- | ------ | ------ | ---- |
| RILD 主线程峰值时延 | 158ms | 26ms | -83% |
| RIL 平均请求时延 | 42ms | 31ms | -26% |
| ANR 次数（7 天样本） | 9 次 | 1 次 | -89% |

## 小结

在不影响对外 RIL 协议的前提下，**异步管道化**是应对 Modem 抖动的
通用策略：把时延从主线程挪开，把“等待”改成“通知”，能显著提升 Telephony
框架在实网下的稳定性。
