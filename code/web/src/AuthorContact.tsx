import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, MessageCircle, X } from "lucide-react";
import { copy } from "./i18n";
import "./author-contact.css";

export function AuthorContact() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const account = useRef<HTMLInputElement>(null);
  const copyAttempt = useRef(0);
  const id = useId();
  const dismiss = useCallback((restoreFocus = false) => {
    copyAttempt.current++;
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    copyButton.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(true); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      copyAttempt.current++;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, dismiss]);

  async function copyWechat() {
    const attempt = ++copyAttempt.current;
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(copy.authorWechat);
      if (attempt === copyAttempt.current) setStatus("copied");
    } catch {
      if (attempt !== copyAttempt.current) return;
      setStatus("failed");
      account.current?.focus();
      account.current?.select();
    }
  }

  return <span className="author-contact" ref={root} onBlur={(event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) dismiss();
  }}>
    <button type="button" className="author-contact-trigger" ref={trigger}
      title={copy.contactAuthor} aria-label={copy.contactAuthor} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => {
        if (open) dismiss();
        else { setStatus("idle"); setOpen(true); }
      }}><MessageCircle size={13} /></button>
    {open && <section id={id} role="dialog" aria-labelledby={`${id}-title`} className="author-contact-popover">
      <div className="author-contact-heading"><h2 id={`${id}-title`}>{copy.contactAuthor}</h2>
        <button type="button" className="plain-icon" title={copy.close} aria-label={copy.close} onClick={() => dismiss(true)}><X size={15} /></button>
      </div>
      <label htmlFor={`${id}-wechat`}>{copy.authorWechatLabel}</label>
      <div className="author-contact-account-row">
        <input id={`${id}-wechat`} ref={account} readOnly value={copy.authorWechat} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="plain-icon" ref={copyButton} title={copy.copyAuthorWechat} aria-label={copy.copyAuthorWechat}
          disabled={status === "copying"} onClick={() => void copyWechat()}>
          {status === "copying" ? <LoaderCircle size={16} className="spinning" /> : status === "copied" ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {status === "copied" && <p className="author-contact-notice" role="status">{copy.authorWechatCopied}</p>}
      {status === "failed" && <p className="author-contact-error" role="alert">{copy.authorWechatCopyFailed}</p>}
    </section>}
  </span>;
}
