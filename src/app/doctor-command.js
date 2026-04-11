import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));

const DOCTOR_SCRIPTS = {
  telegram: path.join(appDir, 'doctor-telegram.js'),
  feishu: path.join(appDir, 'doctor-feishu.js'),
  wechat: path.join(appDir, 'doctor-wechat.js')
};

export function resolveDoctorScript(subcommand) {
  if (!subcommand) return null;
  return DOCTOR_SCRIPTS[String(subcommand).trim().toLowerCase()] ?? null;
}

