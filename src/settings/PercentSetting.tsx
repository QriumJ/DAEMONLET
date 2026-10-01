import { useEffect, useState } from "react"
import { useT } from "../i18n/useLanguage"
export function PercentSetting({ id, label, value, min, max, disabled, onApply }: {
  id: string; label: string; value: number; min: number; max: number; disabled?: boolean; onApply(value: number): void
}) {
  const t = useT(), [text, setText] = useState(String(Math.round(value * 100)))
  useEffect(() => { setText(String(Math.round(value * 100))) }, [value])
  const percent = Number(text), valid = text.trim() !== "" && Number.isFinite(percent) && percent >= min && percent <= max
  return <form className="percent-setting" onSubmit={event => { event.preventDefault(); if (valid) onApply(percent / 100) }}>
    <label className="visually-hidden" htmlFor={id}>{t(label)}</label>
    <input id={id} type="number" min={min} max={max} step="1" value={text} disabled={disabled} aria-invalid={!valid} onChange={event => setText(event.target.value)} />
    <span aria-hidden="true">%</span><button className="button secondary small" disabled={disabled || !valid} type="submit">{t("적용")}</button>
  </form>
}
