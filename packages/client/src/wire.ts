// Generated from probe-rs-rpc's postcard-schema by tools/wire-gen. Do not edit.
// Boundary contract (serde-wasm-bindgen): externally tagged enums; u64/i64 as bigint
// (serialize_large_number_types_as_bigints); None/unit as null (serialize_missing_as_null);
// Vec<u8> as Array<number>.

/**
 * Wire types of the probe-rs RPC protocol, generated from probe-rs-rpc. Most code uses
 * the SDK's own types; these appear where the SDK passes wire values through.
 *
 * @packageDocumentation
 */

/** probe-rs-rpc `ApInfo`. */
export type ApInfo =
  | { MemoryAp: { ap_addr: FullyQualifiedApAddress; component_tree: ComponentTreeNode } }
  | { ApV2Root: { component_tree: ComponentTreeNode } }
  | { Unknown: { ap_addr: FullyQualifiedApAddress; idr: number } };

/** probe-rs-rpc `AppendFileRequest`: `temp_file/append` request. */
export interface AppendFileRequest {
  data: Array<number>;
  key: { key: bigint; marker: null };
}

/** probe-rs-rpc `AttachRequest`: `probe/attach` request. */
export interface AttachRequest {
  chip: (string | null);
  protocol: (WireProtocol | null);
  probe: DebugProbeEntry;
  speed: (number | null);
  connect_under_reset: boolean;
  dry_run: boolean;
  allow_erase_all: boolean;
  resume_target: boolean;
  wait_for_probe: (Duration | null);
}

/** probe-rs-rpc `AttachResult`. */
export type AttachResult =
  | { Success: { key: bigint; marker: null } }
  | "ProbeNotFound"
  | { FailedToOpenProbe: string }
  | "ProbeInUse"
  | { TargetAttachFailed: { message: string; connect_under_reset: boolean } };

/** probe-rs-rpc `BinaryCliOptions`. */
export interface BinaryCliOptions {
  base_address: (bigint | null);
  skip: number;
}

/** probe-rs-rpc `BootInfo`. */
export type BootInfo =
  | { FromRam: { vector_table_addr: bigint; cores_to_reset: Array<string> } }
  | "Other";

/** probe-rs-rpc `BootRequest`: `flash/boot` request. */
export interface BootRequest {
  sessid: { key: bigint; marker: null };
  boot_info: BootInfo;
  core_id: number;
  resume: boolean;
}

/** probe-rs-rpc `BreakpointResolution`. */
export interface BreakpointResolution {
  breakpoint: (WireVerifiedBreakpoint | null);
  error: (string | null);
}

/** probe-rs-rpc `BuildRequest`: `flash/build` request. */
export interface BuildRequest {
  sessid: { key: bigint; marker: null };
  path: string;
  format: FormatOptions;
  image_target: (string | null);
  read_flasher_rtt: boolean;
  rtt_client: ({ key: bigint; marker: null } | null);
}

/** probe-rs-rpc `BuildResult`. */
export interface BuildResult {
  loader: { key: bigint; marker: null };
  boot_info: BootInfo;
}

/** probe-rs-rpc `ChannelInfo`. */
export interface ChannelInfo {
  name: string;
  buffer_size: bigint;
}

/** probe-rs-rpc `ChannelMode`. */
export type ChannelMode =
  | "NoBlockSkip"
  | "NoBlockTrim"
  | "BlockIfFull";

/** probe-rs-rpc `Chip`. */
export interface Chip {
  name: string;
}

/** probe-rs-rpc `ChipData`. */
export interface ChipData {
  cores: Array<Core>;
  memory_map: Array<MemoryRegion>;
}

/** probe-rs-rpc `ChipFamily`. */
export interface ChipFamily {
  name: string;
  manufacturer: (JEP106Code | null);
  variants: Array<Chip>;
}

/** probe-rs-rpc `ChipInfoRequest`: `chips/info` request. */
export interface ChipInfoRequest {
  name: string;
}

/** probe-rs-rpc `ClearCoreDebugStateRequest`: `debug_state/clear_core` request. */
export interface ClearCoreDebugStateRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

/** probe-rs-rpc `ComponentTreeNode`. */
export interface ComponentTreeNode {
  node: string;
  children: Array<ComponentTreeNode>;
}

/** probe-rs-rpc `Core`. */
export interface Core {
  name: string;
  core_type: CoreType;
}

/** probe-rs-rpc `CoreAccessRequest`: `core/status` request, `core/run` request, `core/metadata` request. */
export interface CoreAccessRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

/** probe-rs-rpc `CoreBreakpointsRequest`: `core/set_hw_bps` request, `core/clear_hw_bps` request. */
export interface CoreBreakpointsRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  addresses: Array<bigint>;
}

/** probe-rs-rpc `CoreDumpRequest`: `core/dump` request. */
export interface CoreDumpRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  ranges: Array<{ start: bigint; end: bigint }>;
}

/** probe-rs-rpc `CoreHaltRequest`: `core/halt` request. */
export interface CoreHaltRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  timeout: Duration;
}

/** probe-rs-rpc `CoreReadRegistersRequest`: `core/read_registers` request. */
export interface CoreReadRegistersRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  ids: Array<WireRegisterId>;
}

/** probe-rs-rpc `CoreType`. */
export type CoreType =
  | "Armv6m"
  | "Armv7a"
  | "Armv7r"
  | "Armv7m"
  | "Armv7em"
  | "Armv8a"
  | "Armv8m"
  | "Riscv"
  | "Riscv64"
  | "Xtensa";

/** probe-rs-rpc `CoreVectorCatchRequest`: `core/enable_vc` request. */
export interface CoreVectorCatchRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  condition: WireVectorCatchCondition;
}

/** probe-rs-rpc `CoreWriteRegRequest`: `core/write_reg` request. */
export interface CoreWriteRegRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  id: WireRegisterId;
  value: WireRegisterValue;
}

/** probe-rs-rpc `CoresRequest`: `cores/resume` request, `cores/status` request. */
export interface CoresRequest {
  sessid: { key: bigint; marker: null };
  cores: (Array<number> | null);
}

/** probe-rs-rpc `CoresStatusMap`. */
export interface CoresStatusMap {
  statuses: Array<[number, WireCoreStatus]>;
}

/** probe-rs-rpc `CreateRttClientRequest`: `create_rtt` request. */
export interface CreateRttClientRequest {
  sessid: { key: bigint; marker: null };
  scan_regions: ScanRegion;
  config: Array<RttChannelConfig>;
  default_config: RttChannelConfig;
}

/** probe-rs-rpc `DataFormat`. */
export type DataFormat =
  | "String"
  | "BinaryLE"
  | "Defmt";

/** probe-rs-rpc `DebugPortId`. */
export interface DebugPortId {
  revision: number;
  part_no: number;
  version: DebugPortVersion;
  min_dp_support: MinDpSupport;
  designer: JEP106Code;
}

/** probe-rs-rpc `DebugPortInfo`. */
export interface DebugPortInfo {
  dp_info: DebugPortInfoNode;
  aps: Array<ApInfo>;
}

/** probe-rs-rpc `DebugPortInfoNode`. */
export interface DebugPortInfoNode {
  dp_info: DebugPortId;
  targetid: number;
  dlpidr: number;
}

/** probe-rs-rpc `DebugPortVersion`. */
export type DebugPortVersion =
  | "DPv0"
  | "DPv1"
  | "DPv2"
  | "DPv3"
  | { Unsupported: number };

/** probe-rs-rpc `DebugProbeEntry`. */
export interface DebugProbeEntry {
  identifier: string;
  vendor_id: number;
  product_id: number;
  interface: (number | null);
  serial_number: string;
  probe_type: string;
  inaccessible: boolean;
}

/** probe-rs-rpc `DebugProbeSelector`. */
export interface DebugProbeSelector {
  vendor_id: number;
  product_id: number;
  interface: (number | null);
  serial_number: (string | null);
}

/** probe-rs-rpc `DisassembleRequest`: `core/disassemble` request. */
export interface DisassembleRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  memory_reference: bigint;
  byte_offset: bigint;
  instruction_offset: bigint;
  instruction_count: bigint;
}

/** probe-rs-rpc `DownloadOptions`. */
export interface DownloadOptions {
  keep_unwritten_bytes: boolean;
  do_chip_erase: boolean;
  skip_erase: boolean;
  verify: boolean;
  disable_double_buffering: boolean;
  preferred_algos: Array<string>;
  ram_chunk_size: (bigint | null);
}

/** probe-rs-rpc `DpAddress`. */
export type DpAddress =
  | "Default"
  | { Multidrop: number };

/** probe-rs-rpc `Duration`. */
export interface Duration {
  secs: bigint;
  nanos: number;
}

/** probe-rs-rpc `ElfCliOptions`. */
export interface ElfCliOptions {
  skip_section: Array<string>;
}

/** probe-rs-rpc `EraseAllRequest`: `flash/erase_all` request. */
export interface EraseAllRequest {
  sessid: { key: bigint; marker: null };
  read_flasher_rtt: boolean;
}

/** probe-rs-rpc `EraseRangeRequest`: `flash/erase_range` request. */
export interface EraseRangeRequest {
  sessid: { key: bigint; marker: null };
  address: bigint;
  length: bigint;
  restore: boolean;
  read_flasher_rtt: boolean;
}

/** probe-rs-rpc `EspFlashFrequency`. */
export type EspFlashFrequency =
  | "12MHz"
  | "15MHz"
  | "16MHz"
  | "20MHz"
  | "24MHz"
  | "26MHz"
  | "30MHz"
  | "40MHz"
  | "48MHz"
  | "60MHz"
  | "80MHz";

/** probe-rs-rpc `EspFlashMode`. */
export type EspFlashMode =
  | "qio"
  | "qout"
  | "dio"
  | "dout";

/** probe-rs-rpc `EvaluateRequest`: `stack_trace/evaluate` request. */
export interface EvaluateRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  frame_id: (number | null);
  expression: string;
}

/** probe-rs-rpc `FlashDataBlockSpan`. */
export interface FlashDataBlockSpan {
  address: bigint;
  size: bigint;
}

/** probe-rs-rpc `FlashFill`. */
export interface FlashFill {
  address: bigint;
  size: bigint;
  page_index: bigint;
}

/** probe-rs-rpc `FlashLayout`. */
export interface FlashLayout {
  sectors: Array<FlashSector>;
  pages: Array<FlashPage>;
  fills: Array<FlashFill>;
  data_blocks: Array<FlashDataBlockSpan>;
}

/** probe-rs-rpc `FlashPage`. */
export interface FlashPage {
  address: bigint;
  data_len: bigint;
}

/** probe-rs-rpc `FlashRequest`: `flash/flash` request. */
export interface FlashRequest {
  sessid: { key: bigint; marker: null };
  loader: { key: bigint; marker: null };
  options: DownloadOptions;
}

/** probe-rs-rpc `FlashSector`. */
export interface FlashSector {
  address: bigint;
  size: bigint;
}

/** probe-rs-rpc `FormatKind`. */
export type FormatKind =
  | "Target"
  | "Bin"
  | "Hex"
  | "Elf"
  | "Idf"
  | "Uf2";

/** probe-rs-rpc `FormatOptions`. */
export interface FormatOptions {
  binary_format: FormatKind;
  bin_options: BinaryCliOptions;
  idf_options: IdfCliOptions;
  elf_options: ElfCliOptions;
}

/** probe-rs-rpc `FullyQualifiedApAddress`. */
export interface FullyQualifiedApAddress {
  dp: DpAddress;
  ap: string;
}

/** probe-rs-rpc `GenericRegion`. */
export interface GenericRegion {
  name: (string | null);
  range: [bigint, bigint];
  cores: Array<string>;
  access: (MemoryAccess | null);
}

/** probe-rs-rpc `HaltCoresRequest`: `cores/halt` request. */
export interface HaltCoresRequest {
  sessid: { key: bigint; marker: null };
  cores: (Array<number> | null);
  timeout: Duration;
}

/** probe-rs-rpc `HandleSemihostingRequest`: `core/handle_semihosting` request. */
export interface HandleSemihostingRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

/** probe-rs-rpc `HandleSemihostingResult`. */
export interface HandleSemihostingResult {
  status: WireCoreStatus;
  events: Array<WireSemihostingUiEvent>;
}

/** probe-rs-rpc `IdfCliOptions`. */
export interface IdfCliOptions {
  idf_bootloader: (string | null);
  idf_partition_table: (string | null);
  idf_target_app_partition: (string | null);
  idf_flash_mode: (EspFlashMode | null);
  idf_flash_freq: (EspFlashFrequency | null);
}

/** probe-rs-rpc `InfoEvent`: `info/data` topic. */
export type InfoEvent =
  | { Message: string }
  | { ProtocolNotSupportedByArch: { architecture: string; protocol: WireProtocol } }
  | { ProbeInterfaceMissing: { interface: string; architecture: string } }
  | { Error: { architecture: string; error: string } }
  | { ArmError: { dp_addr: DpAddress; error: string } }
  | { Idcode: { architecture: string; idcode: (number | null) } }
  | { ArmDp: DebugPortInfo };

/** probe-rs-rpc `JEP106Code`. */
export interface JEP106Code {
  id: number;
  cc: number;
}

/** probe-rs-rpc `ListTestsRequest`: `tests/list` request. */
export interface ListTestsRequest {
  sessid: { key: bigint; marker: null };
  boot_info: BootInfo;
  rtt_client: ({ key: bigint; marker: null } | null);
  semihosting_options: SemihostingOptions;
}

/** probe-rs-rpc `LoadChipFamilyRequest`: `chips/load` request. */
export interface LoadChipFamilyRequest {
  families_yaml: string;
}

/** probe-rs-rpc `LoadDebugInfoRequest`: `debug_state/load_debug_info` request. */
export interface LoadDebugInfoRequest {
  sessid: { key: bigint; marker: null };
  path: string;
}

/** probe-rs-rpc `LoadRegionRequest`: `flash/load_region` request. */
export interface LoadRegionRequest {
  sessid: { key: bigint; marker: null };
  loader: { key: bigint; marker: null };
  address: bigint;
  data: Array<number>;
}

/** probe-rs-rpc `LoadSvdRequest`: `debug_state/load_svd` request. */
export interface LoadSvdRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  path: (string | null);
}

/** probe-rs-rpc `Mapping`. */
export type Mapping =
  | { Exact: [string, string] }
  | { Prefix: [string, string] }
  | { Regex: [string, string] };

/** probe-rs-rpc `MemoryAccess`. */
export interface MemoryAccess {
  read: boolean;
  write: boolean;
  execute: boolean;
  boot: boolean;
}

/** probe-rs-rpc `MemoryRegion`. */
export type MemoryRegion =
  | { Ram: RamRegion }
  | { Generic: GenericRegion }
  | { Nvm: NvmRegion };

/** probe-rs-rpc `MinDpSupport`. */
export type MinDpSupport =
  | "NotImplemented"
  | "Implemented";

/** probe-rs-rpc `MonitorExitReason`. */
export type MonitorExitReason =
  | "UserExit"
  | { SemihostingExit: ({ Ok: null } | { Err: SemihostingExitError }) }
  | { Halted: WireHaltReason };

/** probe-rs-rpc `MonitorMode`. */
export type MonitorMode =
  | "AttachToRunning"
  | { Run: BootInfo };

/** probe-rs-rpc `MonitorOptions`. */
export interface MonitorOptions {
  catch_reset: boolean;
  catch_hardfault: boolean;
  catch_svc: boolean;
  catch_hlt: boolean;
  rtt_client: ({ key: bigint; marker: null } | null);
  semihosting_options: SemihostingOptions;
}

/** probe-rs-rpc `MonitorRequest`: `monitor` request. */
export interface MonitorRequest {
  sessid: { key: bigint; marker: null };
  mode: MonitorMode;
  options: MonitorOptions;
}

/** probe-rs-rpc `NewFlashLoaderRequest`: `flash/new` request. */
export interface NewFlashLoaderRequest {
  sessid: { key: bigint; marker: null };
  read_flasher_rtt: boolean;
}

/** probe-rs-rpc `NvmRegion`. */
export interface NvmRegion {
  name: (string | null);
  range: [bigint, bigint];
  cores: Array<string>;
  is_alias: boolean;
  access: (MemoryAccess | null);
}

/** probe-rs-rpc `Operation`. */
export type Operation =
  | "Fill"
  | "Erase"
  | "Program"
  | "Verify"
  | "Ram";

/** probe-rs-rpc `PollRttUpRequest`: `rtt/poll_up` request. */
export interface PollRttUpRequest {
  sessid: { key: bigint; marker: null };
  rtt_client: { key: bigint; marker: null };
  channels: Array<number>;
}

/** probe-rs-rpc `ProgressEvent`: `flash/progress` topic. */
export type ProgressEvent =
  | { FlashLayoutReady: { flash_layout: Array<FlashLayout> } }
  | { AddProgressBar: { operation: Operation; total: (bigint | null) } }
  | { Started: Operation }
  | { Progress: { operation: Operation; size: bigint } }
  | { Failed: Operation }
  | { Finished: Operation }
  | { DiagnosticMessage: { message: string } };

/** probe-rs-rpc `RamRegion`. */
export interface RamRegion {
  name: (string | null);
  range: [bigint, bigint];
  cores: Array<string>;
  access: (MemoryAccess | null);
}

/** probe-rs-rpc `ReadBytesRequest`: `memory/read_bytes` request. */
export interface ReadBytesRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
  count: bigint;
}

/** probe-rs-rpc `ReadMemoryRequest`: `memory/read8` request, `memory/read16` request, `memory/read32` request, `memory/read64` request. */
export interface ReadMemoryRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
  count: number;
}

/** probe-rs-rpc `ResetCoreAndHaltRequest`: `reset_and_halt` request. */
export interface ResetCoreAndHaltRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  timeout: Duration;
}

/** probe-rs-rpc `ResetCoreRequest`: `reset` request. */
export interface ResetCoreRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

/** probe-rs-rpc `ResolveSourceBreakpointsRequest`: `debug_state/resolve_source_breakpoints` request. */
export interface ResolveSourceBreakpointsRequest {
  sessid: { key: bigint; marker: null };
  locations: Array<SourceBreakpointLocation>;
}

/** probe-rs-rpc `ResolveSourceLocationsRequest`: `debug_state/resolve_source_locations` request. */
export interface ResolveSourceLocationsRequest {
  sessid: { key: bigint; marker: null };
  addresses: Array<bigint>;
}

/** probe-rs-rpc `RichStackTrace`. */
export interface RichStackTrace {
  core: number;
  frames: Array<RichStackTraceFrame>;
}

/** probe-rs-rpc `RichStackTraceFrame`. */
export interface RichStackTraceFrame {
  function_name: string;
  program_counter: WireRegisterValue;
  is_inlined: boolean;
  location: (SourceLocation | null);
  frame_base: (bigint | null);
  canonical_frame_address: (bigint | null);
  registers: Array<WireDebugRegister>;
  id: number;
}

/** probe-rs-rpc `RichStackTraces`. */
export interface RichStackTraces {
  cores: Array<RichStackTrace>;
}

/** probe-rs-rpc `RpcError`. */
export type RpcError = string;

/** probe-rs-rpc `RttChannelConfig`. */
export interface RttChannelConfig {
  channelNumber: (number | null);
  dataFormat: DataFormat;
  mode: (ChannelMode | null);
  showTimestamps: boolean;
  showLocation: boolean;
  logFormat: (string | null);
}

/** probe-rs-rpc `RttChannelMeta`. */
export interface RttChannelMeta {
  number: number;
  name: string;
}

/** probe-rs-rpc `RttChannelRequest`: `rtt/channels` request, `rtt/clean_up` request, `rtt/clear_control_block` request. */
export interface RttChannelRequest {
  sessid: { key: bigint; marker: null };
  rtt_client: { key: bigint; marker: null };
}

/** probe-rs-rpc `RttChannels`. */
export interface RttChannels {
  up: Array<RttChannelMeta>;
  down: Array<RttChannelMeta>;
}

/** probe-rs-rpc `RttClientData`. */
export interface RttClientData {
  handle: { key: bigint; marker: null };
  core_id: number;
}

/** probe-rs-rpc `RttDownRequest`: `rtt/down` request. */
export interface RttDownRequest {
  sessid: { key: bigint; marker: null };
  rtt_client: { key: bigint; marker: null };
  channel: number;
  data: Array<number>;
  timeout_ms: number;
}

/** probe-rs-rpc `RttEvent`: `rtt` topic. */
export type RttEvent =
  | { Discovered: { up_channels: Array<ChannelInfo>; down_channels: Array<ChannelInfo> } }
  | { Output: { channel: number; bytes: Array<number> } };

/** probe-rs-rpc `RttPollResult`. */
export interface RttPollResult {
  channel: number;
  result: ({ Ok: Array<number> } | { Err: RpcError });
}

/** probe-rs-rpc `RunTestRequest`: `tests/run` request. */
export interface RunTestRequest {
  sessid: { key: bigint; marker: null };
  test: Test;
  rtt_client: ({ key: bigint; marker: null } | null);
  semihosting_options: SemihostingOptions;
}

/** probe-rs-rpc `ScanRegion`. */
export type ScanRegion =
  | "Ram"
  | { Ranges: Array<[bigint, bigint]> }
  | { Exact: bigint };

/** probe-rs-rpc `ScopesRequest`: `stack_trace/scopes` request. */
export interface ScopesRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  frame_id: number;
}

/** probe-rs-rpc `SelectProbeRequest`: `probe/select` request. */
export interface SelectProbeRequest {
  probe: (DebugProbeSelector | null);
}

/** probe-rs-rpc `SelectProbeResult`. */
export type SelectProbeResult =
  | { Success: DebugProbeEntry }
  | { MultipleProbes: Array<DebugProbeEntry> };

/** probe-rs-rpc `SemihostingEvent`: `semihosting` topic. */
export type SemihostingEvent =
  | { Output: { stream: string; data: string } };

/** probe-rs-rpc `SemihostingExitError`. */
export interface SemihostingExitError {
  reason: number;
  subcode: (number | null);
}

/** probe-rs-rpc `SemihostingOptions`. */
export interface SemihostingOptions {
  mappings: Array<Mapping>;
}

/** probe-rs-rpc `SetVariableRequest`: `stack_trace/set_variable` request. */
export interface SetVariableRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  parent_key: bigint;
  name: string;
  value: string;
}

/** probe-rs-rpc `SourceBreakpointLocation`. */
export interface SourceBreakpointLocation {
  path: string;
  line: bigint;
  column: (bigint | null);
}

/** probe-rs-rpc `SourceLocation`. */
export interface SourceLocation {
  file: string;
  line: (bigint | null);
  column: (bigint | null);
}

/** probe-rs-rpc `StackTrace`. */
export interface StackTrace {
  core: number;
  frames: Array<StackTraceFrame>;
}

/** probe-rs-rpc `StackTraceFrame`. */
export interface StackTraceFrame {
  function_name: string;
  program_counter: bigint;
  is_inlined: boolean;
  location: (SourceLocation | null);
}

/** probe-rs-rpc `StackTraces`. */
export interface StackTraces {
  cores: Array<StackTrace>;
}

/** probe-rs-rpc `StepRequest`: `core/step` request. */
export interface StepRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  mode: WireSteppingMode;
}

/** probe-rs-rpc `StepResponse`. */
export interface StepResponse {
  status: WireCoreStatus;
  program_counter: bigint;
  warning: (string | null);
}

/** probe-rs-rpc `TakeRichStackTraceRequest`: `stack_trace/rich` request. */
export interface TakeRichStackTraceRequest {
  sessid: { key: bigint; marker: null };
  core: (number | null);
  stack_frame_limit: number;
}

/** probe-rs-rpc `TakeStackTraceRequest`: `stack_trace` request. */
export interface TakeStackTraceRequest {
  sessid: { key: bigint; marker: null };
  path: string;
  stack_frame_limit: number;
}

/** probe-rs-rpc `TargetInfoRequest`: `info` request. */
export interface TargetInfoRequest {
  probe: DebugProbeEntry;
  speed: (number | null);
  connect_under_reset: boolean;
  dry_run: boolean;
  target_sel: (number | null);
  protocol: WireProtocol;
  scan_chain: Array<number>;
}

/** probe-rs-rpc `TargetMetadataRequest`: `target/metadata` request. */
export interface TargetMetadataRequest {
  sessid: { key: bigint; marker: null };
}

/** probe-rs-rpc `TempFile`. */
export interface TempFile {
  path: string;
  key: { key: bigint; marker: null };
}

/** probe-rs-rpc `Test`. */
export interface Test {
  name: string;
  expected_outcome: TestOutcome;
  ignored: boolean;
  timeout: (number | null);
  address: (number | null);
}

/** probe-rs-rpc `TestKickoffRequest`: `tests/kickoff` request. */
export interface TestKickoffRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
}

/** probe-rs-rpc `TestOutcome`. */
export type TestOutcome =
  | "Panic"
  | "Pass";

/** probe-rs-rpc `TestResult`. */
export type TestResult =
  | "Success"
  | { Failed: string }
  | "Cancelled";

/** probe-rs-rpc `Tests`. */
export interface Tests {
  version: number;
  tests: Array<Test>;
}

/** probe-rs-rpc `VariablesRequest`: `stack_trace/variables` request. */
export interface VariablesRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  variables_reference: number;
  filter: (string | null);
}

/** probe-rs-rpc `VerifyRequest`: `flash/verify` request. */
export interface VerifyRequest {
  sessid: { key: bigint; marker: null };
  loader: { key: bigint; marker: null };
}

/** probe-rs-rpc `VerifyResult`. */
export type VerifyResult =
  | "Ok"
  | "Mismatch";

/** probe-rs-rpc `WireBreakpointCause`. */
export type WireBreakpointCause =
  | "Hardware"
  | "Software"
  | "Unknown"
  | { Semihosting: WireSemihostingCommand };

/** probe-rs-rpc `WireColumn`. */
export type WireColumn =
  | "LeftEdge"
  | { Column: bigint };

/** probe-rs-rpc `WireCoreDump`. */
export interface WireCoreDump {
  registers: Array<[WireRegisterId, WireRegisterValue]>;
  data: Array<[{ start: bigint; end: bigint }, Array<number>]>;
  instruction_set: WireInstructionSet;
  supports_native_64bit_access: boolean;
  core_type: WireCoreType;
  fpu_support: boolean;
  floating_point_register_count: (bigint | null);
}

/** probe-rs-rpc `WireCoreInformation`. */
export interface WireCoreInformation {
  pc: bigint;
}

/** probe-rs-rpc `WireCoreMetadata`. */
export interface WireCoreMetadata {
  fpu_support: boolean;
  floating_point_register_count: (bigint | null);
  instruction_set: WireInstructionSet;
}

/** probe-rs-rpc `WireCoreStatus`. */
export type WireCoreStatus =
  | "Running"
  | { Halted: WireHaltReason }
  | "LockedUp"
  | "Sleeping"
  | "Unknown";

/** probe-rs-rpc `WireCoreType`. */
export type WireCoreType =
  | "Armv6m"
  | "Armv7a"
  | "Armv7r"
  | "Armv7m"
  | "Armv7em"
  | "Armv8a"
  | "Armv8m"
  | "Riscv"
  | "Riscv64"
  | "Xtensa";

/** probe-rs-rpc `WireDebugRegister`. */
export interface WireDebugRegister {
  id: WireRegisterId;
  dwarf_id: (number | null);
  value: (WireRegisterValue | null);
}

/** probe-rs-rpc `WireDisassembledInstruction`. */
export interface WireDisassembledInstruction {
  address: string;
  column: (bigint | null);
  instruction: string;
  instruction_bytes: (string | null);
  line: (bigint | null);
  location: (WireSource | null);
}

/** probe-rs-rpc `WireEvaluateResponse`. */
export interface WireEvaluateResponse {
  result: string;
  type_: (string | null);
  variables_reference: bigint;
  named_variables: (bigint | null);
  indexed_variables: (bigint | null);
  memory_reference: (string | null);
}

/** probe-rs-rpc `WireExitErrorDetails`. */
export interface WireExitErrorDetails {
  reason: number;
  exit_status: (number | null);
  subcode: (number | null);
}

/** probe-rs-rpc `WireFlashSector`. */
export interface WireFlashSector {
  start: bigint;
  length: bigint;
  blocksize: bigint;
}

/** probe-rs-rpc `WireHaltReason`. */
export type WireHaltReason =
  | "Multiple"
  | { Breakpoint: WireBreakpointCause }
  | "Exception"
  | "Watchpoint"
  | "Step"
  | "Request"
  | "External"
  | "Unknown";

/** probe-rs-rpc `WireInstructionSet`. */
export type WireInstructionSet =
  | "Thumb2"
  | "A32"
  | "A64"
  | "RV32"
  | "RV32C"
  | "RV64"
  | "RV64C"
  | "Xtensa";

/** probe-rs-rpc `WireProtocol`. */
export type WireProtocol =
  | "Jtag"
  | "Swd";

/** probe-rs-rpc `WireRegisterId`. */
export type WireRegisterId = number;

/** probe-rs-rpc `WireRegisterReadResult`. */
export interface WireRegisterReadResult {
  id: WireRegisterId;
  result: ({ Ok: WireRegisterValue } | { Err: RpcError });
}

/** probe-rs-rpc `WireRegisterValue`. */
export type WireRegisterValue =
  | { U32: number }
  | { U64: bigint }
  | { U128: bigint };

/** probe-rs-rpc `WireScope`. */
export interface WireScope {
  name: string;
  presentation_hint: (string | null);
  variables_reference: bigint;
  expensive: boolean;
  line: (bigint | null);
  column: (bigint | null);
}

/** probe-rs-rpc `WireSemihostingCommand`. */
export type WireSemihostingCommand =
  | "ExitSuccess"
  | { ExitError: WireExitErrorDetails }
  | { GetCommandLine: { block_address: number } }
  | "Other";

/** probe-rs-rpc `WireSemihostingUiEvent`. */
export type WireSemihostingUiEvent =
  | { RttWindow: { handle: number; path: string; format: DataFormat } }
  | { LogToConsole: string }
  | { RttOutput: { handle: number; data: string } };

/** probe-rs-rpc `WireSessionCore`. */
export interface WireSessionCore {
  index: number;
  core_type: WireCoreType;
}

/** probe-rs-rpc `WireSessionTargetMetadata`. */
export interface WireSessionTargetMetadata {
  target_name: string;
  default_format: (string | null);
  cores: Array<WireSessionCore>;
  memory_map: Array<MemoryRegion>;
  flash_sectors: Array<WireFlashSector>;
}

/** probe-rs-rpc `WireSetVariableResponse`. */
export interface WireSetVariableResponse {
  value: string;
  type_: (string | null);
  variables_reference: bigint;
  named_variables: (bigint | null);
  indexed_variables: (bigint | null);
  memory_reference: (string | null);
}

/** probe-rs-rpc `WireSource`. */
export interface WireSource {
  name: (string | null);
  path: (string | null);
}

/** probe-rs-rpc `WireSourceLocation`. */
export interface WireSourceLocation {
  path: string;
  line: (bigint | null);
  column: (WireColumn | null);
  address: (bigint | null);
}

/** probe-rs-rpc `WireSteppingMode`. */
export type WireSteppingMode =
  | "StepInstruction"
  | "OverStatement"
  | "IntoStatement"
  | "OutOfStatement";

/** probe-rs-rpc `WireVariable`. */
export interface WireVariable {
  name: string;
  evaluate_name: (string | null);
  memory_reference: (string | null);
  indexed_variables: (bigint | null);
  named_variables: (bigint | null);
  type_: (string | null);
  value: string;
  variables_reference: bigint;
}

/** probe-rs-rpc `WireVectorCatchCondition`. */
export type WireVectorCatchCondition =
  | "HardFault"
  | "CoreReset"
  | "SecureFault"
  | "All"
  | "Svc"
  | "Hlt";

/** probe-rs-rpc `WireVerifiedBreakpoint`. */
export interface WireVerifiedBreakpoint {
  address: bigint;
  source_location: WireSourceLocation;
}

/** probe-rs-rpc `WriteMemoryRequest`: `memory/write8` request, `memory/write16` request, `memory/write32` request, `memory/write64` request. */
export interface WriteMemoryRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
  data: Array<number>;
}

/** Every RPC endpoint by path, with its request and response types. */
export interface Endpoints {
  "probe/list": { request: null; response: ({ Ok: Array<DebugProbeEntry> } | { Err: RpcError }) };
  "probe/select": { request: SelectProbeRequest; response: ({ Ok: SelectProbeResult } | { Err: RpcError }) };
  "probe/attach": { request: AttachRequest; response: ({ Ok: AttachResult } | { Err: RpcError }) };
  "cores/halt": { request: HaltCoresRequest; response: ({ Ok: CoresStatusMap } | { Err: RpcError }) };
  "cores/resume": { request: CoresRequest; response: ({ Ok: CoresStatusMap } | { Err: RpcError }) };
  "cores/status": { request: CoresRequest; response: ({ Ok: CoresStatusMap } | { Err: RpcError }) };
  "flash/new": { request: NewFlashLoaderRequest; response: ({ Ok: { key: bigint; marker: null } } | { Err: RpcError }) };
  "flash/build": { request: BuildRequest; response: ({ Ok: BuildResult } | { Err: RpcError }) };
  "flash/load_region": { request: LoadRegionRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "flash/flash": { request: FlashRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "flash/erase_all": { request: EraseAllRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "flash/erase_range": { request: EraseRangeRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "flash/verify": { request: VerifyRequest; response: ({ Ok: VerifyResult } | { Err: RpcError }) };
  "flash/boot": { request: BootRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "monitor": { request: MonitorRequest; response: ({ Ok: MonitorExitReason } | { Err: RpcError }) };
  "stack_trace": { request: TakeStackTraceRequest; response: ({ Ok: StackTraces } | { Err: RpcError }) };
  "stack_trace/rich": { request: TakeRichStackTraceRequest; response: ({ Ok: RichStackTraces } | { Err: RpcError }) };
  "stack_trace/scopes": { request: ScopesRequest; response: ({ Ok: Array<WireScope> } | { Err: RpcError }) };
  "stack_trace/variables": { request: VariablesRequest; response: ({ Ok: Array<WireVariable> } | { Err: RpcError }) };
  "stack_trace/evaluate": { request: EvaluateRequest; response: ({ Ok: WireEvaluateResponse } | { Err: RpcError }) };
  "stack_trace/set_variable": { request: SetVariableRequest; response: ({ Ok: WireSetVariableResponse } | { Err: RpcError }) };
  "debug_state/load_debug_info": { request: LoadDebugInfoRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "debug_state/resolve_source_breakpoints": { request: ResolveSourceBreakpointsRequest; response: ({ Ok: Array<BreakpointResolution> } | { Err: RpcError }) };
  "debug_state/resolve_source_locations": { request: ResolveSourceLocationsRequest; response: ({ Ok: Array<(WireSourceLocation | null)> } | { Err: RpcError }) };
  "debug_state/clear_core": { request: ClearCoreDebugStateRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "debug_state/load_svd": { request: LoadSvdRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "create_rtt": { request: CreateRttClientRequest; response: ({ Ok: RttClientData } | { Err: RpcError }) };
  "rtt/down": { request: RttDownRequest; response: ({ Ok: number } | { Err: RpcError }) };
  "rtt/channels": { request: RttChannelRequest; response: ({ Ok: RttChannels } | { Err: RpcError }) };
  "rtt/poll_up": { request: PollRttUpRequest; response: ({ Ok: Array<RttPollResult> } | { Err: RpcError }) };
  "rtt/clean_up": { request: RttChannelRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "rtt/clear_control_block": { request: RttChannelRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "tests/list": { request: ListTestsRequest; response: ({ Ok: Tests } | { Err: RpcError }) };
  "tests/run": { request: RunTestRequest; response: ({ Ok: TestResult } | { Err: RpcError }) };
  "tests/kickoff": { request: TestKickoffRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "temp_file/new": { request: null; response: ({ Ok: TempFile } | { Err: RpcError }) };
  "temp_file/append": { request: AppendFileRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "chips/list": { request: null; response: ({ Ok: Array<ChipFamily> } | { Err: RpcError }) };
  "chips/info": { request: ChipInfoRequest; response: ({ Ok: ChipData } | { Err: RpcError }) };
  "chips/load": { request: LoadChipFamilyRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "target/metadata": { request: TargetMetadataRequest; response: ({ Ok: WireSessionTargetMetadata } | { Err: RpcError }) };
  "info": { request: TargetInfoRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "reset": { request: ResetCoreRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "reset_and_halt": { request: ResetCoreAndHaltRequest; response: ({ Ok: WireCoreInformation } | { Err: RpcError }) };
  "core/status": { request: CoreAccessRequest; response: ({ Ok: WireCoreStatus } | { Err: RpcError }) };
  "core/halt": { request: CoreHaltRequest; response: ({ Ok: WireCoreInformation } | { Err: RpcError }) };
  "core/run": { request: CoreAccessRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "core/step": { request: StepRequest; response: ({ Ok: StepResponse } | { Err: RpcError }) };
  "core/write_reg": { request: CoreWriteRegRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "core/set_hw_bps": { request: CoreBreakpointsRequest; response: ({ Ok: Array<({ Ok: null } | { Err: RpcError })> } | { Err: RpcError }) };
  "core/clear_hw_bps": { request: CoreBreakpointsRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "core/enable_vc": { request: CoreVectorCatchRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "core/metadata": { request: CoreAccessRequest; response: ({ Ok: WireCoreMetadata } | { Err: RpcError }) };
  "core/read_registers": { request: CoreReadRegistersRequest; response: ({ Ok: Array<WireRegisterReadResult> } | { Err: RpcError }) };
  "core/dump": { request: CoreDumpRequest; response: ({ Ok: WireCoreDump } | { Err: RpcError }) };
  "core/handle_semihosting": { request: HandleSemihostingRequest; response: ({ Ok: HandleSemihostingResult } | { Err: RpcError }) };
  "core/disassemble": { request: DisassembleRequest; response: ({ Ok: Array<WireDisassembledInstruction> } | { Err: RpcError }) };
  "memory/read8": { request: ReadMemoryRequest; response: ({ Ok: Array<number> } | { Err: RpcError }) };
  "memory/read16": { request: ReadMemoryRequest; response: ({ Ok: Array<number> } | { Err: RpcError }) };
  "memory/read32": { request: ReadMemoryRequest; response: ({ Ok: Array<number> } | { Err: RpcError }) };
  "memory/read64": { request: ReadMemoryRequest; response: ({ Ok: Array<bigint> } | { Err: RpcError }) };
  "memory/read_bytes": { request: ReadBytesRequest; response: ({ Ok: Array<number> } | { Err: RpcError }) };
  "memory/write8": { request: WriteMemoryRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "memory/write16": { request: WriteMemoryRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "memory/write32": { request: WriteMemoryRequest; response: ({ Ok: null } | { Err: RpcError }) };
  "memory/write64": { request: WriteMemoryRequest; response: ({ Ok: null } | { Err: RpcError }) };
}

/** Every RPC topic by path, with its message type. */
export interface Topics {
  "cancel": null;
  "info/data": InfoEvent;
  "flash/progress": ProgressEvent;
  "rtt": RttEvent;
  "semihosting": SemihostingEvent;
}
