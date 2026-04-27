/**
 * cli/doctor/types.ts — Doctor check types
 */

export type DoctorStatus = "pass" | "warn" | "fail" | "info";

export type DoctorCategory =
  | "system" | "config" | "credentials" | "agent" | "sessions"
  | "stt" | "systemd" | "network" | "disk" | "permissions";

export interface DoctorContext {
  fix: boolean;
  verbose: boolean;
  json: boolean;
  configPath: string;
  envFilePath: string;
  serviceName: string;
  now: Date;
  env: NodeJS.ProcessEnv;
}

export interface DoctorFix {
  description: string;
  command?: string;
  run?: (ctx: DoctorContext) => Promise<boolean>;
}

export interface DoctorCheckResult {
  id: string;
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  summary: string;
  details?: string[];
  fix?: DoctorFix;
  fixed?: boolean;
}

export interface DoctorCheck {
  id: string;
  category: DoctorCategory;
  name: string;
  run(ctx: DoctorContext): Promise<DoctorCheckResult>;
}
