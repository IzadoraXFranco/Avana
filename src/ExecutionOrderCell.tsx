import { useEffect, useRef, useState } from "react";
import { scopedStorageKey } from "./api";

type Props = {
  taskId: string;
  title: string;
  value: number | null;
  disabled: boolean;
  onSave: (order: number | null) => Promise<unknown>;
};
type NumberDraft = { text: string; base: number | null; revision: string };
const memoryDrafts = new Map<string, NumberDraft>();
const draftKey = (taskId: string) => scopedStorageKey(`avana:execution-order-draft:${taskId}`);
const textOf = (value: number | null) => value?.toString() || "";
const validNumber = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 99999;

function readDraft(storageKey: string) {
  try {
    const raw = localStorage.getItem(storageKey);
    const stored = raw ? JSON.parse(raw) : null;
    const valid =
      stored &&
      typeof stored.text === "string" &&
      (stored.base === null || validNumber(stored.base)) &&
      typeof stored.revision === "string";
    return {
      record:
        memoryDrafts.get(storageKey) || (valid ? (stored as NumberDraft) : null),
      unavailable: false,
    };
  } catch {
    return { record: memoryDrafts.get(storageKey) || null, unavailable: true };
  }
}

function persistDraft(storageKey: string, record: NumberDraft): boolean {
  memoryDrafts.set(storageKey, record);
  try {
    localStorage.setItem(storageKey, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function forgetDraft(storageKey: string, revision: string): boolean {
  if (memoryDrafts.get(storageKey)?.revision === revision)
    memoryDrafts.delete(storageKey);
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw && JSON.parse(raw).revision === revision)
      localStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

// A task change mounts an independent editor, keeping its draft and request lifecycle separate.
export default function ExecutionOrderCell(props: Props) {
  return <NumberEditor key={props.taskId} {...props} />;
}

function NumberEditor({ taskId, title, value, disabled, onSave }: Props) {
  const [storageKey] = useState(() => draftKey(taskId));
  const [initial] = useState(() => readDraft(storageKey));
  const [pending, setPending] = useState<NumberDraft | null>(initial.record);
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [storageUnavailable, setStorageUnavailable] = useState(
    initial.unavailable,
  );
  const pendingRef = useRef(pending);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const draft = pending?.text ?? textOf(value);
  const conflict = !!pending && pending.base !== value;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function clear(record: NumberDraft) {
    setStorageUnavailable(!forgetDraft(storageKey, record.revision));
    if (pendingRef.current?.revision === record.revision) {
      pendingRef.current = null;
      setPending(null);
    }
    setError("");
  }

  // A restored draft may already have been saved by a request finishing after navigation.
  useEffect(() => {
    if (!pending || saving) return;
    const text = pending.text.trim();
    const order =
      text === ""
        ? null
        : /^\d+$/.test(text) && validNumber(Number(text))
          ? Number(text)
          : undefined;
    if (order !== undefined && order === value) clear(pending);
  }, [pending, value, saving]);

  useEffect(() => {
    if (!pending || !storageUnavailable) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, storageUnavailable]);

  const save = async (replaceChangedValue = false) => {
    const record = pendingRef.current;
    if (savingRef.current || disabled || !record) return;
    const text = record.text.trim();
    if (text && (!/^\d+$/.test(text) || !validNumber(Number(text)))) {
      setError("Use um número inteiro de 1 a 99999.");
      return;
    }
    const order = text ? Number(text) : null;
    if (order === value) {
      clear(record);
      return;
    }
    if (record.base !== value && !replaceChangedValue) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(order);
      // Always clear the submitted revision, even if its row has since unmounted.
      // A newer edit has another revision and must survive this response.
      const removed = forgetDraft(storageKey, record.revision);
      if (mounted.current) {
        setStorageUnavailable(!removed);
        if (pendingRef.current?.revision === record.revision) {
          pendingRef.current = null;
          setPending(null);
        }
      }
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof Error
            ? err.message
            : "Não foi possível salvar. Seu número foi preservado.",
        );
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <div className="execution-order-cell">
      <input
        type="text"
        inputMode="numeric"
        aria-label={`Ordem de execução de ${title}`}
        aria-invalid={!!error || conflict}
        title={
          error ||
          (conflict
            ? "O número salvo mudou. Escolha qual valor manter."
            : "Digite a sequência: 1, 2, 3… Apague para deixar sem ordem.")
        }
        placeholder="—"
        value={!focused && /^\d+$/.test(draft) ? `${Number(draft)}º` : draft}
        disabled={disabled || saving}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          const record = {
            text: event.target.value,
            base: pendingRef.current ? pendingRef.current.base : value,
            revision: crypto.randomUUID(),
          };
          pendingRef.current = record;
          setPending(record);
          setStorageUnavailable(!persistDraft(storageKey, record));
          setError("");
        }}
        onBlur={() => {
          setFocused(false);
          void save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (pendingRef.current) clear(pendingRef.current);
          }
        }}
      />
      {saving && (
        <span className="cell-saving" role="status">
          Salvando…
        </span>
      )}
      {pending && storageUnavailable && !saving && (
        <span
          className="cell-saving"
          role="status"
          title="O navegador não permitiu guardar o rascunho. Ele permanece nesta aba; salve antes de fechá-la."
        >
          Rascunho nesta aba
        </span>
      )}
      {pending && !storageUnavailable && !saving && !conflict && (
        <span className="cell-saving" role="status">
          Não salvo
        </span>
      )}
      {conflict && !saving ? (
        <div className="cell-error" role="alert">
          <span>
            O valor salvo mudou para{" "}
            {value === null ? "sem ordem" : `${value}º`}. Seu número foi
            preservado.
          </span>
          {error && <span>{error}</span>}
          <button
            type="button"
            disabled={disabled}
            onClick={() => void save(true)}
          >
            Salvar meu número
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (pendingRef.current) clear(pendingRef.current);
            }}
          >
            Usar valor salvo
          </button>
        </div>
      ) : (
        error && (
          <div className="cell-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              disabled={disabled || saving}
              onClick={() => void save()}
            >
              Tentar novamente
            </button>
          </div>
        )
      )}
    </div>
  );
}
