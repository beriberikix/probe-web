// Generated from probe-rs-rpc's postcard-schema by spike-schema-ts. Do not edit.
// Boundary contract (serde-wasm-bindgen): externally tagged enums; u64/i64 as bigint
// (serialize_large_number_types_as_bigints); None/unit as null (serialize_missing_as_null);
// Vec<u8> as Array<number>.

export type ApInfo =
  | { MemoryAp: { ap_addr: FullyQualifiedApAddress; component_tree: ComponentTreeNode } }
  | { ApV2Root: { component_tree: ComponentTreeNode } }
  | { Unknown: { ap_addr: FullyQualifiedApAddress; idr: number } };

export interface AppendFileRequest {
  data: Array<number>;
  key: { key: bigint; marker: null };
}

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

export type AttachResult =
  | { Success: { key: bigint; marker: null } }
  | "ProbeNotFound"
  | { FailedToOpenProbe: string }
  | "ProbeInUse"
  | { TargetAttachFailed: { message: string; connect_under_reset: boolean } };

export interface BinaryCliOptions {
  base_address: (bigint | null);
  skip: number;
}

export type BootInfo =
  | { FromRam: { vector_table_addr: bigint; cores_to_reset: Array<string> } }
  | "Other";

export interface BootRequest {
  sessid: { key: bigint; marker: null };
  boot_info: BootInfo;
  core_id: number;
  resume: boolean;
}

export interface BreakpointResolution {
  breakpoint: (WireVerifiedBreakpoint | null);
  error: (string | null);
}

export interface BuildRequest {
  sessid: { key: bigint; marker: null };
  path: string;
  format: FormatOptions;
  image_target: (string | null);
  read_flasher_rtt: boolean;
  rtt_client: ({ key: bigint; marker: null } | null);
}

export interface BuildResult {
  loader: { key: bigint; marker: null };
  boot_info: BootInfo;
}

export interface ChannelInfo {
  name: string;
  buffer_size: bigint;
}

export type ChannelMode =
  | "NoBlockSkip"
  | "NoBlockTrim"
  | "BlockIfFull";

export interface Chip {
  name: string;
}

export interface ChipData {
  cores: Array<Core>;
  memory_map: Array<MemoryRegion>;
}

export interface ChipFamily {
  name: string;
  manufacturer: (JEP106Code | null);
  variants: Array<Chip>;
}

export interface ChipInfoRequest {
  name: string;
}

export interface ClearCoreDebugStateRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

export interface ComponentTreeNode {
  node: string;
  children: Array<null>;
}

export interface Core {
  name: string;
  core_type: CoreType;
}

export interface CoreAccessRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

export interface CoreBreakpointsRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  addresses: Array<bigint>;
}

export interface CoreDumpRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  ranges: Array<{ start: bigint; end: bigint }>;
}

export interface CoreHaltRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  timeout: Duration;
}

export interface CoreReadRegistersRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  ids: Array<WireRegisterId>;
}

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

export interface CoreVectorCatchRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  condition: WireVectorCatchCondition;
}

export interface CoreWriteRegRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  id: WireRegisterId;
  value: WireRegisterValue;
}

export interface CoresRequest {
  sessid: { key: bigint; marker: null };
  cores: (Array<number> | null);
}

export interface CoresStatusMap {
  statuses: Array<[number, WireCoreStatus]>;
}

export interface CreateRttClientRequest {
  sessid: { key: bigint; marker: null };
  scan_regions: ScanRegion;
  config: Array<RttChannelConfig>;
  default_config: RttChannelConfig;
}

export type DataFormat =
  | "String"
  | "BinaryLE"
  | "Defmt";

export interface DebugPortId {
  revision: number;
  part_no: number;
  version: DebugPortVersion;
  min_dp_support: MinDpSupport;
  designer: JEP106Code;
}

export interface DebugPortInfo {
  dp_info: DebugPortInfoNode;
  aps: Array<ApInfo>;
}

export interface DebugPortInfoNode {
  dp_info: DebugPortId;
  targetid: number;
  dlpidr: number;
}

export type DebugPortVersion =
  | "DPv0"
  | "DPv1"
  | "DPv2"
  | "DPv3"
  | { Unsupported: number };

export interface DebugProbeEntry {
  identifier: string;
  vendor_id: number;
  product_id: number;
  interface: (number | null);
  serial_number: string;
  probe_type: string;
  inaccessible: boolean;
}

export interface DebugProbeSelector {
  vendor_id: number;
  product_id: number;
  interface: (number | null);
  serial_number: (string | null);
}

export interface DisassembleRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  memory_reference: bigint;
  byte_offset: bigint;
  instruction_offset: bigint;
  instruction_count: bigint;
}

export interface DownloadOptions {
  keep_unwritten_bytes: boolean;
  do_chip_erase: boolean;
  skip_erase: boolean;
  verify: boolean;
  disable_double_buffering: boolean;
  preferred_algos: Array<string>;
  ram_chunk_size: (bigint | null);
}

export type DpAddress =
  | "Default"
  | { Multidrop: number };

export interface Duration {
  secs: bigint;
  nanos: number;
}

export interface ElfCliOptions {
  skip_section: Array<string>;
}

export interface EraseAllRequest {
  sessid: { key: bigint; marker: null };
  read_flasher_rtt: boolean;
}

export interface EraseRangeRequest {
  sessid: { key: bigint; marker: null };
  address: bigint;
  length: bigint;
  restore: boolean;
  read_flasher_rtt: boolean;
}

export type EspFlashFrequency =
  | "12mhz"
  | "15mhz"
  | "16mhz"
  | "20mhz"
  | "24mhz"
  | "26mhz"
  | "30mhz"
  | "40mhz"
  | "48mhz"
  | "60mhz"
  | "80mhz";

export type EspFlashMode =
  | "qio"
  | "qout"
  | "dio"
  | "dout";

export interface EvaluateRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  frame_id: (number | null);
  expression: string;
}

export interface FlashDataBlockSpan {
  address: bigint;
  size: bigint;
}

export interface FlashFill {
  address: bigint;
  size: bigint;
  page_index: bigint;
}

export interface FlashLayout {
  sectors: Array<FlashSector>;
  pages: Array<FlashPage>;
  fills: Array<FlashFill>;
  data_blocks: Array<FlashDataBlockSpan>;
}

export interface FlashPage {
  address: bigint;
  data_len: bigint;
}

export interface FlashRequest {
  sessid: { key: bigint; marker: null };
  loader: { key: bigint; marker: null };
  options: DownloadOptions;
}

export interface FlashSector {
  address: bigint;
  size: bigint;
}

export type FormatKind =
  | "Target"
  | "Bin"
  | "Hex"
  | "Elf"
  | "Idf"
  | "Uf2";

export interface FormatOptions {
  binary_format: FormatKind;
  bin_options: BinaryCliOptions;
  idf_options: IdfCliOptions;
  elf_options: ElfCliOptions;
}

export interface FullyQualifiedApAddress {
  dp: DpAddress;
  ap: string;
}

export interface GenericRegion {
  name: (string | null);
  range: [bigint, bigint];
  cores: Array<string>;
  access: (MemoryAccess | null);
}

export interface HaltCoresRequest {
  sessid: { key: bigint; marker: null };
  cores: (Array<number> | null);
  timeout: Duration;
}

export interface HandleSemihostingRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

export interface HandleSemihostingResult {
  status: WireCoreStatus;
  events: Array<WireSemihostingUiEvent>;
}

export interface IdfCliOptions {
  idf_bootloader: (string | null);
  idf_partition_table: (string | null);
  idf_target_app_partition: (string | null);
  idf_flash_mode: (EspFlashMode | null);
  idf_flash_freq: (EspFlashFrequency | null);
}

export type InfoEvent =
  | { Message: string }
  | { ProtocolNotSupportedByArch: { architecture: string; protocol: WireProtocol } }
  | { ProbeInterfaceMissing: { interface: string; architecture: string } }
  | { Error: { architecture: string; error: string } }
  | { ArmError: { dp_addr: DpAddress; error: string } }
  | { Idcode: { architecture: string; idcode: (number | null) } }
  | { ArmDp: DebugPortInfo };

export interface JEP106Code {
  id: number;
  cc: number;
}

export interface ListTestsRequest {
  sessid: { key: bigint; marker: null };
  boot_info: BootInfo;
  rtt_client: ({ key: bigint; marker: null } | null);
  semihosting_options: SemihostingOptions;
}

export interface LoadChipFamilyRequest {
  families_yaml: string;
}

export interface LoadDebugInfoRequest {
  sessid: { key: bigint; marker: null };
  path: string;
}

export interface LoadRegionRequest {
  sessid: { key: bigint; marker: null };
  loader: { key: bigint; marker: null };
  address: bigint;
  data: Array<number>;
}

export interface LoadSvdRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  path: (string | null);
}

export type Mapping =
  | { Exact: [string, string] }
  | { Prefix: [string, string] }
  | { Regex: [string, string] };

export interface MemoryAccess {
  read: boolean;
  write: boolean;
  execute: boolean;
  boot: boolean;
}

export type MemoryRegion =
  | { Ram: RamRegion }
  | { Generic: GenericRegion }
  | { Nvm: NvmRegion };

export type MinDpSupport =
  | "NotImplemented"
  | "Implemented";

export type MonitorExitReason =
  | "UserExit"
  | { SemihostingExit: ({ Ok: null } | { Err: SemihostingExitError }) }
  | { Halted: WireHaltReason };

export type MonitorMode =
  | "AttachToRunning"
  | { Run: BootInfo };

export interface MonitorOptions {
  catch_reset: boolean;
  catch_hardfault: boolean;
  catch_svc: boolean;
  catch_hlt: boolean;
  rtt_client: ({ key: bigint; marker: null } | null);
  semihosting_options: SemihostingOptions;
}

export interface MonitorRequest {
  sessid: { key: bigint; marker: null };
  mode: MonitorMode;
  options: MonitorOptions;
}

export interface NewFlashLoaderRequest {
  sessid: { key: bigint; marker: null };
  read_flasher_rtt: boolean;
}

export interface NvmRegion {
  name: (string | null);
  range: [bigint, bigint];
  cores: Array<string>;
  is_alias: boolean;
  access: (MemoryAccess | null);
}

export type Operation =
  | "Fill"
  | "Erase"
  | "Program"
  | "Verify"
  | "Ram";

export interface PollRttUpRequest {
  sessid: { key: bigint; marker: null };
  rtt_client: { key: bigint; marker: null };
  channels: Array<number>;
}

export type ProgressEvent =
  | { FlashLayoutReady: { flash_layout: Array<FlashLayout> } }
  | { AddProgressBar: { operation: Operation; total: (bigint | null) } }
  | { Started: Operation }
  | { Progress: { operation: Operation; size: bigint } }
  | { Failed: Operation }
  | { Finished: Operation }
  | { DiagnosticMessage: { message: string } };

export interface RamRegion {
  name: (string | null);
  range: [bigint, bigint];
  cores: Array<string>;
  access: (MemoryAccess | null);
}

export interface ReadBytesRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
  count: bigint;
}

export interface ReadMemoryRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
  count: number;
}

export interface ResetCoreAndHaltRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  timeout: Duration;
}

export interface ResetCoreRequest {
  sessid: { key: bigint; marker: null };
  core: number;
}

export interface ResolveSourceBreakpointsRequest {
  sessid: { key: bigint; marker: null };
  locations: Array<SourceBreakpointLocation>;
}

export interface ResolveSourceLocationsRequest {
  sessid: { key: bigint; marker: null };
  addresses: Array<bigint>;
}

export interface RichStackTrace {
  core: number;
  frames: Array<RichStackTraceFrame>;
}

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

export interface RichStackTraces {
  cores: Array<RichStackTrace>;
}

export type RpcError = string;

export interface RttChannelConfig {
  channelNumber: (number | null);
  dataFormat: DataFormat;
  mode: (ChannelMode | null);
  showTimestamps: boolean;
  showLocation: boolean;
  logFormat: (string | null);
}

export interface RttChannelMeta {
  number: number;
  name: string;
}

export interface RttChannelRequest {
  sessid: { key: bigint; marker: null };
  rtt_client: { key: bigint; marker: null };
}

export interface RttChannels {
  up: Array<RttChannelMeta>;
  down: Array<RttChannelMeta>;
}

export interface RttClientData {
  handle: { key: bigint; marker: null };
  core_id: number;
}

export interface RttDownRequest {
  sessid: { key: bigint; marker: null };
  rtt_client: { key: bigint; marker: null };
  channel: number;
  data: Array<number>;
  timeout_ms: number;
}

export type RttEvent =
  | { Discovered: { up_channels: Array<ChannelInfo>; down_channels: Array<ChannelInfo> } }
  | { Output: { channel: number; bytes: Array<number> } };

export interface RttPollResult {
  channel: number;
  result: ({ Ok: Array<number> } | { Err: RpcError });
}

export interface RunTestRequest {
  sessid: { key: bigint; marker: null };
  test: Test;
  rtt_client: ({ key: bigint; marker: null } | null);
  semihosting_options: SemihostingOptions;
}

export type ScanRegion =
  | "Ram"
  | { Ranges: Array<[bigint, bigint]> }
  | { Exact: bigint };

export interface ScopesRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  frame_id: number;
}

export interface SelectProbeRequest {
  probe: (DebugProbeSelector | null);
}

export type SelectProbeResult =
  | { Success: DebugProbeEntry }
  | { MultipleProbes: Array<DebugProbeEntry> };

export type SemihostingEvent =
  | { Output: { stream: string; data: string } };

export interface SemihostingExitError {
  reason: number;
  subcode: (number | null);
}

export interface SemihostingOptions {
  mappings: Array<Mapping>;
}

export interface SetVariableRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  parent_key: bigint;
  name: string;
  value: string;
}

export interface SourceBreakpointLocation {
  path: string;
  line: bigint;
  column: (bigint | null);
}

export interface SourceLocation {
  file: string;
  line: (bigint | null);
  column: (bigint | null);
}

export interface StackTrace {
  core: number;
  frames: Array<StackTraceFrame>;
}

export interface StackTraceFrame {
  function_name: string;
  program_counter: bigint;
  is_inlined: boolean;
  location: (SourceLocation | null);
}

export interface StackTraces {
  cores: Array<StackTrace>;
}

export interface StepRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  mode: WireSteppingMode;
}

export interface StepResponse {
  status: WireCoreStatus;
  program_counter: bigint;
  warning: (string | null);
}

export interface TakeRichStackTraceRequest {
  sessid: { key: bigint; marker: null };
  core: (number | null);
  stack_frame_limit: number;
}

export interface TakeStackTraceRequest {
  sessid: { key: bigint; marker: null };
  path: string;
  stack_frame_limit: number;
}

export interface TargetInfoRequest {
  probe: DebugProbeEntry;
  speed: (number | null);
  connect_under_reset: boolean;
  dry_run: boolean;
  target_sel: (number | null);
  protocol: WireProtocol;
  scan_chain: Array<number>;
}

export interface TargetMetadataRequest {
  sessid: { key: bigint; marker: null };
}

export interface TempFile {
  path: string;
  key: { key: bigint; marker: null };
}

export interface Test {
  name: string;
  expected_outcome: TestOutcome;
  ignored: boolean;
  timeout: (number | null);
  address: (number | null);
}

export interface TestKickoffRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
}

export type TestOutcome =
  | "Panic"
  | "Pass";

export type TestResult =
  | "Success"
  | { Failed: string }
  | "Cancelled";

export interface Tests {
  version: number;
  tests: Array<Test>;
}

export interface VariablesRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  variables_reference: number;
  filter: (string | null);
}

export interface VerifyRequest {
  sessid: { key: bigint; marker: null };
  loader: { key: bigint; marker: null };
}

export type VerifyResult =
  | "Ok"
  | "Mismatch";

export type WireBreakpointCause =
  | "Hardware"
  | "Software"
  | "Unknown"
  | { Semihosting: WireSemihostingCommand };

export type WireColumn =
  | "LeftEdge"
  | { Column: bigint };

export interface WireCoreDump {
  registers: Array<[WireRegisterId, WireRegisterValue]>;
  data: Array<[{ start: bigint; end: bigint }, Array<number>]>;
  instruction_set: WireInstructionSet;
  supports_native_64bit_access: boolean;
  core_type: WireCoreType;
  fpu_support: boolean;
  floating_point_register_count: (bigint | null);
}

export interface WireCoreInformation {
  pc: bigint;
}

export interface WireCoreMetadata {
  fpu_support: boolean;
  floating_point_register_count: (bigint | null);
  instruction_set: WireInstructionSet;
}

export type WireCoreStatus =
  | "Running"
  | { Halted: WireHaltReason }
  | "LockedUp"
  | "Sleeping"
  | "Unknown";

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

export interface WireDebugRegister {
  id: WireRegisterId;
  dwarf_id: (number | null);
  value: (WireRegisterValue | null);
}

export interface WireDisassembledInstruction {
  address: string;
  column: (bigint | null);
  instruction: string;
  instruction_bytes: (string | null);
  line: (bigint | null);
  location: (WireSource | null);
}

export interface WireEvaluateResponse {
  result: string;
  type_: (string | null);
  variables_reference: bigint;
  named_variables: (bigint | null);
  indexed_variables: (bigint | null);
  memory_reference: (string | null);
}

export interface WireExitErrorDetails {
  reason: number;
  exit_status: (number | null);
  subcode: (number | null);
}

export interface WireFlashSector {
  start: bigint;
  length: bigint;
  blocksize: bigint;
}

export type WireHaltReason =
  | "Multiple"
  | { Breakpoint: WireBreakpointCause }
  | "Exception"
  | "Watchpoint"
  | "Step"
  | "Request"
  | "External"
  | "Unknown";

export type WireInstructionSet =
  | "Thumb2"
  | "A32"
  | "A64"
  | "RV32"
  | "RV32C"
  | "RV64"
  | "RV64C"
  | "Xtensa";

export type WireProtocol =
  | "Jtag"
  | "Swd";

export type WireRegisterId = number;

export interface WireRegisterReadResult {
  id: WireRegisterId;
  result: ({ Ok: WireRegisterValue } | { Err: RpcError });
}

export type WireRegisterValue =
  | { U32: number }
  | { U64: bigint }
  | { U128: bigint };

export interface WireScope {
  name: string;
  presentation_hint: (string | null);
  variables_reference: bigint;
  expensive: boolean;
  line: (bigint | null);
  column: (bigint | null);
}

export type WireSemihostingCommand =
  | "ExitSuccess"
  | { ExitError: WireExitErrorDetails }
  | { GetCommandLine: { block_address: number } }
  | "Other";

export type WireSemihostingUiEvent =
  | { RttWindow: { handle: number; path: string; format: DataFormat } }
  | { LogToConsole: string }
  | { RttOutput: { handle: number; data: string } };

export interface WireSessionCore {
  index: number;
  core_type: WireCoreType;
}

export interface WireSessionTargetMetadata {
  target_name: string;
  default_format: (string | null);
  cores: Array<WireSessionCore>;
  memory_map: Array<MemoryRegion>;
  flash_sectors: Array<WireFlashSector>;
}

export interface WireSetVariableResponse {
  value: string;
  type_: (string | null);
  variables_reference: bigint;
  named_variables: (bigint | null);
  indexed_variables: (bigint | null);
  memory_reference: (string | null);
}

export interface WireSource {
  name: (string | null);
  path: (string | null);
}

export interface WireSourceLocation {
  path: string;
  line: (bigint | null);
  column: (WireColumn | null);
  address: (bigint | null);
}

export type WireSteppingMode =
  | "StepInstruction"
  | "OverStatement"
  | "IntoStatement"
  | "OutOfStatement";

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

export type WireVectorCatchCondition =
  | "HardFault"
  | "CoreReset"
  | "SecureFault"
  | "All"
  | "Svc"
  | "Hlt";

export interface WireVerifiedBreakpoint {
  address: bigint;
  source_location: WireSourceLocation;
}

export interface WriteMemoryRequest {
  sessid: { key: bigint; marker: null };
  core: number;
  address: bigint;
  data: Array<number>;
}

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

export interface Topics {
  "cancel": null;
  "info/data": InfoEvent;
  "flash/progress": ProgressEvent;
  "rtt": RttEvent;
  "semihosting": SemihostingEvent;
}
