---
title: "技术博客源码环境搭建指南"
date: "2025-06-22"
summary: "本博客所有技术分析文章均基于 AOSP（Android Open Source Project）源码。本文档列出所需的 21 个源码仓库及其克隆命令，覆盖 Telephony Framework、通话管理、数据网络、RIL、IMS、短信彩信、联系人、广播等全链路模块，方便读者搭建本地源码环境，对照博客内容进行阅读和验证。"
category: "source-env"
tags: ["AOSP", "源码环境", "Telephony", "RIL", "Framework", "IMS", "Connectivity", "NetworkStack", "CellBroadcast"]
featured: false
---

> 本博客所有技术分析文章均基于 **AOSP（Android Open Source Project）** 源码，代码引用均来自以下仓库。
> 建议读者在本地克隆对应仓库，以便对照博客内容进行阅读和验证。

---

## 一、源码仓库列表

以下 21 个仓库涵盖了本博客涉及的所有模块，从 Telephony Framework 到 RIL 层、从通话应用到 IMS 子系统、从数据网络到短信广播。

### Telephony Framework 核心

#### 1. frameworks/opt/telephony

Telephony 框架核心模块，包含 ServiceStateTracker、Phone、Call、DataNetworkController、PhoneSwitcher 等 Telephony 核心类的实现。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/frameworks/opt/telephony -b android17-release
```

**涉及文章**：全部博客文章（核心仓库）

#### 2. frameworks/base

Android 基础框架，包含 `android.telephony` 公共 API 定义、ServiceState 等数据类、ConnectivityManager、TelecomManager 等系统服务接口。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/frameworks/base -b android17-release
```

**涉及文章**：开机驻网全流程梳理、运营商名称显示机制详解、数据网络切换分析

---

### 系统服务层

#### 3. packages/services/Telephony

Telephony 应用层服务，包含 TeleService、TelephonyProvider、MmsService、CarrierService 等系统应用与服务。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/services/Telephony -b android17-release
```

**涉及文章**：开机驻网全流程梳理、运营商名称显示机制详解、数据业务分析

#### 4. packages/services/Telecomm

Telecom 框架服务，负责通话路由、ConnectionService 管理、PhoneAccount 注册、InCallService 绑定等通话核心逻辑。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/services/Telecomm -b android17-release
```

**涉及文章**：通话模块基本架构梳理、紧急通话 PhoneAccount 创建流程

#### 5. packages/services/Mms

MMS 服务，负责彩信（多媒体短信）的收发处理，包括 WAP Push 解析、TransactionService 下载与持久化。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/services/Mms -b android17-release
```

**涉及文章**：彩信接收与自动下载全流程分析

---

### 系统应用层

#### 6. packages/apps/Dialer

Android 原生拨号应用，展示通话 UI 层的实现，包含拨号盘、通话记录、联系人快捷拨号等功能。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/Dialer -b android17-release
```

**涉及文章**：通话模块基本架构梳理

#### 7. packages/apps/Messaging

Android 原生短信应用，负责 SMS/MMS 的 UI 展示、短信编辑与发送、会话管理。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/Messaging -b android17-release
```

**涉及文章**：短信收发流程分析

#### 8. packages/apps/Contacts

Android 原生联系人应用，负责联系人数据的展示、编辑与同步。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/Contacts -b android17-release
```

**涉及文章**：联系人相关功能分析

#### 9. packages/apps/Stk

SIM Toolkit 应用，负责 STK 菜单的展示与交互，处理 SIM 卡上的增值业务菜单。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/Stk -b android17-release
```

**涉及文章**：SIM 卡相关功能分析

#### 10. packages/apps/PhoneCommon

拨号应用公共库，包含拨号应用与通话界面共享的通用组件和工具类。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/PhoneCommon -b android17-release
```

**涉及文章**：通话模块基本架构梳理

#### 11. packages/apps/EmergencyInfo

紧急信息应用，负责紧急联系人信息的管理与展示，在紧急呼叫时提供给救援机构。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/EmergencyInfo -b android17-release
```

**涉及文章**：紧急通话相关功能分析

---

### IMS 与网络协议

#### 12. frameworks/opt/net/ims

IMS（IP Multimedia Subsystem）框架，负责 VoLTE、VoNR、WiFi Calling 等 IMS 通话功能，包含 ImsService、MmTelFeature、SipTransport 等核心类。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/frameworks/opt/net/ims -b android17-release
```

**涉及文章**：通话模块基本架构梳理、IMS 注册流程分析

---

### ContentProvider 层

#### 13. packages/providers/TelephonyProvider

TelephonyProvider，负责短信、彩信、APN 等数据的持久化存储，提供 `content://sms`、`content://mms`、`content://telephony/carriers` 等 URI。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/providers/TelephonyProvider -b android17-release
```

**涉及文章**：短信/彩信存储机制、APN 配置分析

#### 14. packages/providers/ContactsProvider

ContactsProvider，负责联系人数据的存储与同步，提供 `content://com.android.contacts` URI。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/providers/ContactsProvider -b android17-release
```

**涉及文章**：联系人相关功能分析

#### 15. packages/providers/CallLogProvider

CallLogProvider，负责通话记录的存储与查询，提供 `content://call_log` URI。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/providers/CallLogProvider -b android17-release
```

**涉及文章**：通话记录相关功能分析

---

### 网络与连接

#### 16. packages/modules/NetworkStack

网络协议栈模块，负责 IP 协议处理、DHCP、ARP 等底层网络功能。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/modules/NetworkStack -b android17-release
```

**涉及文章**：网络连接底层协议分析

#### 17. packages/modules/Connectivity

Connectivity 模块，负责网络连接管理、NetworkScore 评分、WiFi/蜂窝网络切换、默认网络路由等核心功能。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/modules/Connectivity -b android17-release
```

**涉及文章**：WiFi 与蜂窝数据切换及 NetworkScore 评分机制、数据网络激活流程

---

### 小区广播

#### 18. packages/modules/CellBroadcastService

小区广播服务，负责接收和处理基站下发的小区广播消息（如地震预警、 amber alert）。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/modules/CellBroadcastService -b android17-release
```

**涉及文章**：小区广播接收流程分析

#### 19. packages/modules/CellBroadcastReceiver

小区广播接收器，负责小区广播消息的 UI 展示与通知分发。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/modules/CellBroadcastReceiver -b android17-release
```

**涉及文章**：小区广播接收流程分析

---

### 硬件抽象层

#### 20. hardware/ril

RIL（Radio Interface Layer）硬件抽象层，负责 Framework 与 Modem 之间的通信，定义了 RIL 请求/响应格式和 Radio HAL 接口。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/hardware/ril -b android17-release
```

**涉及文章**：开机驻网全流程梳理、运营商名称显示机制详解、数据业务分析

#### 21. hardware/interfaces

Android 硬件接口定义，包含 Radio HAL（`android.hardware.radio`）、Secure Element HAL、SIM HAL 等 AIDL/HIDL 接口定义。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/hardware/interfaces -b android17-release
```

**涉及文章**：Radio AIDL 升级适配、HAL 接口分析

---

## 二、一键克隆脚本

将以下内容保存为 `clone-aosp.sh`，在目标目录下执行即可一次性克隆全部仓库：

```bash
#!/bin/bash
MIRROR="https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform"
BRANCH="android17-release"

repos=(
  # Telephony Framework 核心
  "frameworks/opt/telephony"
  "frameworks/base"
  # 系统服务层
  "packages/services/Telephony"
  "packages/services/Telecomm"
  "packages/services/Mms"
  # 系统应用层
  "packages/apps/Dialer"
  "packages/apps/Messaging"
  "packages/apps/Contacts"
  "packages/apps/Stk"
  "packages/apps/PhoneCommon"
  "packages/apps/EmergencyInfo"
  # IMS 与网络协议
  "frameworks/opt/net/ims"
  # ContentProvider 层
  "packages/providers/TelephonyProvider"
  "packages/providers/ContactsProvider"
  "packages/providers/CallLogProvider"
  # 网络与连接
  "packages/modules/NetworkStack"
  "packages/modules/Connectivity"
  # 小区广播
  "packages/modules/CellBroadcastService"
  "packages/modules/CellBroadcastReceiver"
  # 硬件抽象层
  "hardware/ril"
  "hardware/interfaces"
)

for repo in "${repos[@]}"; do
  echo ">>> Cloning $repo (branch: $BRANCH) ..."
  git clone "$MIRROR/$repo" -b "$BRANCH"
  echo ""
done

echo "All repositories cloned successfully."
```

---

## 三、克隆后的目录结构

```
<你的工作目录>/
├── frameworks/
│   ├── base/                       # android.telephony 公共 API / ConnectivityManager
│   └── opt/
│       ├── telephony/              # Telephony Framework 核心
│       └── net/
│           └── ims/                # IMS/VoLTE 框架
├── packages/
│   ├── apps/
│   │   ├── Dialer/                 # 拨号应用
│   │   ├── Messaging/              # 短信应用
│   │   ├── Contacts/               # 联系人应用
│   │   ├── Stk/                    # SIM Toolkit 应用
│   │   ├── PhoneCommon/            # 拨号公共库
│   │   └── EmergencyInfo/          # 紧急信息应用
│   ├── services/
│   │   ├── Telephony/              # TeleService / TelephonyProvider / MmsService
│   │   ├── Telecomm/               # Telecom 服务
│   │   └── Mms/                    # MMS 服务
│   ├── providers/
│   │   ├── TelephonyProvider/      # 短信/彩信/APN ContentProvider
│   │   ├── ContactsProvider/       # 联系人 ContentProvider
│   │   └── CallLogProvider/        # 通话记录 ContentProvider
│   └── modules/
│       ├── NetworkStack/           # 网络协议栈
│       ├── Connectivity/           # 连接管理服务
│       ├── CellBroadcastService/   # 小区广播服务
│       └── CellBroadcastReceiver/  # 小区广播接收器
└── hardware/
    ├── ril/                        # RIL 硬件抽象层
    └── interfaces/                 # HAL 接口定义（Radio AIDL）
```

---

## 四、源码阅读建议

1. **使用 Android Studio**：直接用 Android Studio 打开单个仓库（如 `frameworks/opt/telephony`），可享受代码跳转、搜索、引用查找等功能
2. **关键代码路径速查**：

   | 模块 | 关键路径 |
   |------|---------|
   | ServiceStateTracker | `telephony/src/java/com/android/internal/telephony/ServiceStateTracker.java` |
   | Phone 基类 | `telephony/src/java/com/android/internal/telephony/Phone.java` |
   | DataNetworkController | `telephony/src/java/com/android/internal/telephony/data/DataNetworkController.java` |
   | PhoneSwitcher | `telephony/src/java/com/android/internal/telephony/data/PhoneSwitcher.java` |
   | SIM 卡记录 | `telephony/src/java/com/android/internal/telephony/uicc/` |
   | CDNR | `telephony/src/java/com/android/internal/telephony/cdnr/` |
   | Telecom 服务 | `Telecomm/src/com/android/server/telecom/` |
   | ConnectivityService | `Connectivity/service/src/com/android/server/ConnectivityService.java` |
   | NetworkRanker | `Connectivity/service/src/com/android/server/connectivity/NetworkRanker.java` |
   | RIL 接口 | `ril/src/java/com/android/internal/telephony/` |
   | Radio HAL | `hardware/interfaces/radio/` |
   | ServiceState API | `base/telephony/java/android/telephony/ServiceState.java` |

3. **源码版本**：本博客文章基于 **`android17-release`** 分支分析，建议切换到该分支进行对照阅读。
