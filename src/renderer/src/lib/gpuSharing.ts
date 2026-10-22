import { activeProfile, type AppSettings } from '../../../shared/types'

/** GPUs with this much memory hold the vision models and a small local model at once. */
const ROOMY_GPU_MIB = 12 * 1024

/** Whether a run should keep one AI at a time on the GPU (see GpuSharing). */
export async function runPhased(settings: AppSettings): Promise<boolean> {
  if (settings.gpuSharing !== 'auto') return settings.gpuSharing === 'phased'
  const profile = activeProfile(settings)
  // A model on another machine doesn't use this GPU.
  if (profile?.kind !== 'openai' || !isLocalUrl(profile.baseUrl)) return false
  const gpu = await window.api.ai.gpu().catch(() => null)
  return !!gpu && gpu.memoryTotal < ROOMY_GPU_MIB
}

function isLocalUrl(url: string): boolean {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}
