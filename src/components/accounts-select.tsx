import { Select } from "./ui";

export type AccOpt = { id: string; label: string; code: string; group: string };

/** Account picker grouped by plain-language group names. */
export function AccountSelect({ name, options, defaultValue, placeholder = "Choose…", showCodes = false, required = true }:
  { name: string; options: AccOpt[]; defaultValue?: string; placeholder?: string; showCodes?: boolean; required?: boolean }) {
  const groups = [...new Set(options.map((o) => o.group))];
  return <Select name={name} defaultValue={defaultValue ?? ""} required={required}>
    <option value="">{placeholder}</option>
    {groups.map((g) => <optgroup key={g} label={g}>
      {options.filter((o) => o.group === g).map((o) => <option key={o.id} value={o.id}>{showCodes ? `${o.code} · ` : ""}{o.label}</option>)}
    </optgroup>)}
  </Select>;
}
