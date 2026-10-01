import { AUTO_LANGUAGE, LANGUAGES } from '../../../shared/types'

interface Props {
  value: string
  onChange: (value: string) => void
  allowAuto?: boolean
}

export function LanguageSelect({ value, onChange, allowAuto }: Props) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAuto && <option value={AUTO_LANGUAGE}>Detectar automaticamente</option>}
      {LANGUAGES.map((lang) => (
        <option key={lang.value} value={lang.value}>
          {lang.label}
        </option>
      ))}
    </select>
  )
}
