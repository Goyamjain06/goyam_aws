import { createContext, useContext } from 'react'
import type { AQData } from './model'

export const DataCtx = createContext<AQData | null>(null)
export function useData(): AQData {
  const d = useContext(DataCtx)
  if (!d) throw new Error('data not loaded')
  return d
}
