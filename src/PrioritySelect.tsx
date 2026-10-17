import type { Priority } from "./types";
import { priorityLabels } from "./dates";

export default function PrioritySelect({
  value,
  onChange,
  disabled,
  id,
  "aria-label": label,
}: {
  value: Priority;
  onChange: (value: Priority) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  return (
    <span className={`priority-control priority-${value || "none"}`}>
      <span className="priority-dot" aria-hidden="true" />
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as Priority)}
      >
        {Object.entries(priorityLabels).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </span>
  );
}
