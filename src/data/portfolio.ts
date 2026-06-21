import type { TimelineItem, ProjectItem, SkillMatrixGroup } from '@/types';

export const skills: SkillMatrixGroup[] = [
  {
    key: 'ril',
    title: 'RIL / Modem 协议',
    description: 'Android Telephony RIL 层与 Modem 信令交互，AT/QMI/MBIM 指令流。',
    skills: [
      { name: 'Qualcomm QCRIL / QMI', level: 92 },
      { name: 'MediaTek RIL / MUX', level: 88 },
      { name: 'AT Command 扩展与解析', level: 94 },
      { name: 'RILD / vendor RIL 定制', level: 85 },
      { name: 'Modem 崩溃 / T32 / Ramdump', level: 80 },
    ],
  },
  {
    key: 'ims',
    title: 'IMS / VoLTE / VoNR',
    description: 'IMS 注册、SIP/SDP、语音视频呼叫、紧急呼叫、SRVCC/eSRVCC 流程。',
    skills: [
      { name: 'SIP / SDP / RTP / RTCP', level: 90 },
      { name: 'IMS AKA / 注册流程', level: 82 },
      { name: 'VoLTE / VoNR 接通与掉话', level: 86 },
      { name: 'SRVCC / eSRVCC / 切换', level: 78 },
      { name: 'Emergency / E911 / 多路呼叫', level: 74 },
    ],
  },
  {
    key: 'network',
    title: '搜网 / 小区 / 数据连接',
    description: 'PLMN 搜网、频段锁、小区重选/切换、PS 数据业务稳定性。',
    skills: [
      { name: 'PLMN 搜网策略与优化', level: 90 },
      { name: '频段锁 / 切片 / NSA/SA', level: 82 },
      { name: 'PDU Session / PDP Context', level: 80 },
      { name: 'TCP/IP 数据包路径', level: 78 },
      { name: 'Ping 延迟 / 吞吐调优', level: 76 },
    ],
  },
  {
    key: 'platform',
    title: '工程化 / 工具链',
    description: '构建系统、日志抓取、抓包分析、自动化回归与可观测性。',
    skills: [
      { name: 'Android Build / Soong / Make', level: 82 },
      { name: 'QXDM / Wireshark / tcpdump', level: 88 },
      { name: 'Git / Gerrit / CI', level: 85 },
      { name: 'C / C++ / Java / Kotlin', level: 90 },
      { name: '性能 Profiling / ANR / Watchdog', level: 80 },
    ],
  },
];

export const timeline: TimelineItem[] = [
  {
    year: '2024 — Now',
    title: 'Senior Telephony Engineer',
    org: '某 Android 终端厂商',
    description: '负责旗舰机型 RIL/IMS 性能与稳定性、5G 搜网策略优化、版本交付与问题闭环。',
    highlights: [
      '重构搜网仲裁器，首搜耗时由 28s 降至 10.6s',
      '主导 VoLTE 接通率从 97.1% 提升至 99.6%',
      '搭建 RIL 自动化回归流水线，覆盖 480+ 用例',
    ],
  },
  {
    year: '2021 — 2024',
    title: 'Telephony Framework Engineer',
    org: '某消费电子公司',
    description: 'MTK & 高通双平台 RIL 中间层定制，IMS/VoLTE 模块扩展与问题定位。',
    highlights: [
      'MTK 平台自研 RIL 扩展指令，覆盖 30+ 项目',
      '设计 RIL Request 时序可视化工具',
      '减少 Modem Crash 回归周期问题 40%',
    ],
  },
  {
    year: '2019 — 2021',
    title: 'Android Telephony Engineer',
    org: '某 ODM 公司',
    description: 'Android Telephony 应用层与 Service 开发，双卡/多 IMS 定制。',
    highlights: [
      '实现双卡双待 IMS 多路呼叫管理',
      '建立 Telephony 日志抓取自动化脚本',
      '主导 15+ 海外运营商 IOT 认证',
    ],
  },
  {
    year: '2015 — 2019',
    title: 'B.Eng. in Communication Engineering',
    org: '某某大学',
    description: '通信原理、数字信号处理、无线通信系统、TCP/IP 网络基础。',
    highlights: ['通信原理课程设计：基于 USRP 的 OFDM 传输', '毕设：SIP 软电话实现与 QoS 分析'],
  },
];

export const projects: ProjectItem[] = [
  {
    title: '5G 搜网耗时优化',
    subtitle: '自研 PLMN 搜网仲裁器 + 频段偏好预测',
    period: '2023.05 — 2024.02',
    stack: ['C++', 'Android RIL', 'QCRIL', 'QXDM', 'Python'],
    situation:
      '旗舰机型海外漫游首搜耗时平均 28s，局部运营商/频段组合可达 42s，严重影响开机体验与市场口碑。',
    task:
      '设计新的搜网策略，在不牺牲注册成功率的前提下，将首搜耗时控制在 12s 内，同时满足多运营商 IOT 认证。',
    action:
      '基于 RRC 状态机与频段历史数据，增加 Fast-Scan 阶段与 MCC/MNC 快速匹配；将静态 Band 列表替换为动态偏好队列，避免无效扫描；在 QCRIL 层注入异步回调降低线程阻塞。',
    result:
      '首搜平均耗时下降 62%，极端场景下降 71%；开机首注册成功率 99.8%，通过 8 家运营商 IOT 认证。',
    metrics: [
      { label: '首搜耗时(平均)', value: '10.6s', delta: '-62%' },
      { label: '首搜耗时(极端)', value: '12.2s', delta: '-71%' },
      { label: '注册成功率', value: '99.8%', delta: '+1.6%' },
      { label: '运营商 IOT', value: '8/8', delta: '通过' },
    ],
    snippets: [
      {
        lang: 'cpp',
        caption: 'QCRIL 扩展：异步扫描回调注入',
        code: `// vendor/qcom/proprietary/qcril/hooks/scan_policy.cpp
namespace qcril::scan {

Response<void> fast_scan_arbitrate(const Request& req) {
  // 1) 按 MCC 优先构造 Fast-Band 集合
  auto bands = build_fast_bands(req.preferred_mcc);
  // 2) 注入异步回调避免阻塞 RILD 主线程
  return qmi_async(WDS_START_SCAN, bands, [](auto& evt) {
    if (evt.status == SCAN_OK) {
      RIL_LOG("scan_ok: cells=%zu", evt.cells.size());
    }
  });
}

} // namespace qcril::scan`,
      },
    ],
    screenshots: [
      { alt: 'QXDM 抓包：RRC Setup 时序', src: '/images/samples/qxdm-sample.svg' },
      { alt: 'Wireshark：NAS / RRC 层包', src: '/images/samples/wireshark-sample.svg' },
    ],
  },
  {
    title: 'IMS 接通率与掉话治理',
    subtitle: 'SIP/SDP 信令分析 + 重传/超时策略微调',
    period: '2022.10 — 2023.06',
    stack: ['IMS', 'SIP', 'C++', 'Java', 'Wireshark'],
    situation:
      'VoLTE/VoNR 在特定城市弱网下接通率下降至 96%，偶发 380/488 响应与 408 超时，客户投诉集中。',
    task:
      '建立端到端 SIP 信令观测与根因定位方法论，将弱网接通率提升到 99% 以上，掉话率下降 60%。',
    action:
      '重构 SIP UA 状态机：对 408/INVITE 超时实施分级重试；结合 RTP/RTCP 观测动态切换 T1/T2 定时器；在 IMS 服务侧增加信令失败白名单与降级切换通道。',
    result: '弱网接通率由 96.1% 升至 99.4%，掉话事件下降 61%；整体用户投诉下降 47%。',
    metrics: [
      { label: 'VoLTE 接通率', value: '99.4%', delta: '+3.3%' },
      { label: 'VoNR 接通率', value: '99.6%', delta: '+2.1%' },
      { label: '掉话事件', value: '周均 23', delta: '-61%' },
      { label: '用户投诉', value: '-47%', delta: '月度' },
    ],
    snippets: [
      {
        lang: 'java',
        caption: 'IMS 服务：408 分级重试',
        code: `// ImsPhone.java
void handleInviteTimeout(SipCallSession session) {
  int level = session.retryLevel();
  if (level < 2 && network.isWeakCoverage()) {
    session.scheduleRetry(level, Duration.ofMillis(600 + level * 400));
  } else if (level < 3) {
    fallbackToCsfb(session);
  } else {
    notifyCallFailed(session, 408);
  }
}`,
      },
    ],
  },
  {
    title: 'Modem Crash 自动化归因',
    subtitle: 'T32 / Ramdump 解析 + 特征聚类',
    period: '2023.03 — 2023.11',
    stack: ['Python', 'T32', 'SQLite', 'Shell'],
    situation:
      'Modem 侧 Crash 每周产生 80+ Ramdump，人工排查耗时长，部分问题反复回归，影响版本交付节奏。',
    task:
      '构建自动化 Ramdump 解析与归因系统，将人工处理耗时由 >2h 降到 <5min，并识别 Top3 重复问题。',
    action:
      '通过 T32 CLI + 自研脚本提取 PC/LR、调用栈、关键寄存器与 NV 配置；以栈签名聚类并建立问题库；在 CI 中集成回归检测，提前阻断已知问题。',
    result: '平均排查耗时下降 95%，Top3 回归问题彻底清零，版本交付稳定性显著提升。',
    metrics: [
      { label: '处理耗时', value: '<5min', delta: '-95%' },
      { label: '重复问题', value: '0', delta: '清零' },
      { label: '覆盖版本', value: '12+', delta: '产品线' },
      { label: '识别准确率', value: '98.2%', delta: '首版' },
    ],
    snippets: [
      {
        lang: 'python',
        caption: 'Ramdump 栈签名与聚类',
        code: `def signature(frames: list[str]) -> str:
    return hashlib.sha1("|".join(frames[:8]).encode()).hexdigest()[:10]

def cluster(dumps: list[Dump]) -> dict[str, list[Dump]]:
    groups: dict[str, list[Dump]] = {}
    for d in dumps:
        sig = signature(d.callstack)
        groups.setdefault(sig, []).append(d)
    return groups`,
      },
    ],
  },
  {
    title: 'MTK RIL 多路数据定制',
    subtitle: '双卡 PDP / 切片感知与策略路由',
    period: '2021.08 — 2022.05',
    stack: ['C', 'MTK RIL', 'Java', 'Android'],
    situation:
      '双卡机型存在运营商切片数据卡切换滞后，峰值业务吞吐达不到理论值，海外 MBB 项目被点名。',
    task:
      '在 MTK RIL 中实现卡感知的 PDP Context 调度；提供 Framework 侧扩展 API 支持上层业务指定切片。',
    action:
      '扩展 RIL 自定义 Request；实现 PDP Context 池与优先级队列；在 DataConnection 层注入切片路由表，并提供 Java 层 AIDL 接口给业务模块调用。',
    result:
      '切片切换时延下降 55%，高优业务吞吐稳定在理论值 ±5% 内，MBB 项目顺利通过运营商验收。',
    metrics: [
      { label: '切片切换', value: '280ms', delta: '-55%' },
      { label: '高优吞吐', value: '理论值 ±5%', delta: '稳定' },
      { label: 'AIDL 接口', value: '12+', delta: '业务' },
      { label: '运营商验收', value: '通过', delta: '全项' },
    ],
    snippets: [
      {
        lang: 'c',
        caption: 'MTK RIL：切片路由请求扩展',
        code: `// vendor/mediatek/ril/ril_slice.c
static void onRequestSliceRoute(int slot, void *data, size_t len) {
  SliceRouteReq req = {0};
  if (!parse_slice_req(data, len, &req)) {
    RIL_onRequestComplete(RIL_E_GENERIC_FAILURE, NULL, 0);
    return;
  }
  int cid = pdp_pool_acquire(slot, req.dnn, PDP_HIGH_PRIO);
  if (cid < 0) { RIL_onRequestComplete(RIL_E_GENERIC_FAILURE, NULL, 0); return; }
  RIL_onRequestComplete(RIL_E_SUCCESS, &cid, sizeof(cid));
}`,
      },
    ],
  },
];
