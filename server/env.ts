export function loadEnv() {
  try { process.loadEnvFile(); }
  catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error; }
}
