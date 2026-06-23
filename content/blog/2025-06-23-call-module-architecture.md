---
title: "Android 通话模块基本架构梳理"
date: "2025-06-23"
summary: "从应用层到 Modem 层，系统梳理 Android 通话模块的完整架构。涵盖框架分层、Telephony/Telecom Framework 职责、5 大 AIDL 交互接口，以及 CS 拨号流程。"
category: "call-module"
tags: ["通话管理", "Telecom", "TeleService", "AIDL", "CS拨号", "Framework", "RIL"]
featured: true
---

## 一、框架总览

Android 通话模块是一个从应用层贯穿到 Modem 层的完整链路，各层职责分明：

| 层级 | 组件 | 说明 |
|------|------|------|
| 应用层 | Contacts.apk、TeleService.apk、Telecom.apk、IncallUI.apk | 用户可见的拨号、通话界面 |
| 框架层 | Telephony FW (`frameworks/opt/telephony`)、Telecom FW (`frameworks/base/telecom`) | Android 通话核心框架 |
| HAL 层 | RIL (Radio Interface Layer) | AP 与 BP 之间的通信桥梁 |
| BP 层 | Modem | 实际负责无线通信的基带处理器 |

> **[架构图]** 应用层 → Framework 层 → RIL HAL 层 → Modem BP 层的完整通话链路

<div class="arch-diagram">
  <div class="arch-layer" style="background:rgba(74,222,128,0.12);border-color:rgba(74,222,128,0.4)">
    <div class="arch-layer-label">Java Application</div>
    <div class="arch-components">
      <span class="arch-box">Dialer</span>
      <span class="arch-box">Telephony</span>
      <span class="arch-box">Telecom</span>
      <span class="arch-box">IncallUI</span>
    </div>
  </div>
  <div class="arch-arrow">▼</div>
  <div class="arch-layer" style="background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.4)">
    <div class="arch-layer-label">Java Framework</div>
    <div class="arch-components">
      <span class="arch-box arch-box-nested">
        telephony fw
        <span class="arch-box-inner">RILJ</span>
      </span>
      <span class="arch-box">telecom FW</span>
    </div>
  </div>
  <div class="arch-arrow">▼</div>
  <div class="arch-layer" style="background:rgba(34,211,238,0.12);border-color:rgba(34,211,238,0.4)">
    <div class="arch-layer-label">Hardware Abstract Layer (C++)</div>
    <div class="arch-components">
      <span class="arch-box">RILD</span>
    </div>
  </div>
  <div class="arch-arrow">▼</div>
  <div class="arch-layer" style="background:rgba(248,113,113,0.15);border-color:rgba(248,113,113,0.5)">
    <div class="arch-layer-label">Modem</div>
  </div>
</div>

## 二、各进程交互的 AIDL 接口

通话模块涉及多个进程间的 AIDL 跨进程通信，核心接口如下：

### 1. ITelecomService.aidl

- **实现类**: `com.android.server.telecom.TelecomServiceImpl`
- **作用**: Telecom 框架对外暴露的系统服务接口，管理通话路由、音频路由等

> **[流程图]** ITelecomService.aidl 接口定义与 TelecomServiceImpl 实现关系

### 2. IInCallService.aidl

- **实现类**: `android.telecom.InCallService.InCallServiceBinder` (InCallServiceImpl)
- **作用**: 通话界面服务接口，IncallUI 通过此接口与 Telecom 服务交互，展示通话状态

### 3. ICallAdapter.aidl

- **实现类**: `com.android.server.telecom.InCallAdapter`
- **作用**: 通话适配器，提供通话控制操作（接听、挂断、静音等）的跨进程调用能力

### 4. IConnectionService.aidl

- **实现类**: `android.telecom.ConnectionService#mBinder`
- **作用**: 连接服务接口，TeleService 通过此接口向 Telecom 注册并管理通话连接

### 5. IConnectionServiceAdapter.aidl

- **实现类**: `com.android.server.telecom.ConnectionServiceWrapper.Adapter`
- **作用**: 连接服务适配器，Telecom 通过此回调接口通知 TeleService 通话状态变化

> **[流程图]** 5 大 AIDL 接口的进程间交互关系：Telecom ↔ TeleService ↔ IncallUI

## 三、CS 拨号流程

CS (Circuit Switched) 拨号是传统的电路交换语音通话流程，是 Android 通话模块最基础也是最核心的功能。

### 拨号发起链路

```
用户点击拨号
  → Contacts / Dialer 应用
    → TelecomManager.placeCall()
      → TelecomServiceImpl
        → ConnectionServiceWrapper
          → TeleService (ConnectionService)
            → GsmCdmaPhone.dial()
              → RIL.dial()
                → Modem (AT 命令)
```

### 关键阶段说明

1. **应用层发起**: Dialer 应用通过 `TelecomManager.placeCall()` 向系统请求建立通话
2. **Telecom 路由**: TelecomService 根据配置选择对应的 ConnectionService（通常是 TeleService）
3. **TeleService 处理**: TeleService 的 ConnectionService 实现负责与 RIL 交互，发起实际的拨号请求
4. **RIL 透传**: RIL 将 Framework 层的拨号请求转换为 AT 命令发送给 Modem
5. **Modem 执行**: Modem 通过无线信道与网络侧建立电路交换连接

> **[流程图]** CS 拨号完整时序：Dialer → Telecom → TeleService → RIL → Modem → 网络侧

## 四、总结

Android 通话模块的核心设计思想是**分层解耦**：

- **Telecom Framework** 负责通话路由、音频管理、界面调度
- **Telephony Framework** 负责与 RIL/Modem 交互，处理底层网络协议
- **AIDL 接口** 实现进程间通信，保证各组件独立演进

**排障要点**：
- 拨号无响应：检查 TelecomService 是否正常运行、ConnectionService 绑定是否成功
- 通话状态不同步：排查 IInCallService 回调链路、IncallUI 是否正确注册监听
- 底层拨号失败：检查 RIL 日志中 AT 命令响应、Modem 是否返回 ERROR
