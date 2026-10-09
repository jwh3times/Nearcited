import {
  AUDIT_MAX_PROMPTS,
  AUDIT_MAX_SAMPLES,
  type AuditFormValues,
  AuditInputSchema,
} from "@nearcited/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { useFormErrors } from "../lib/form";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";

const EMPTY = { business_name: "", website: "", city: "", region: "", samples: "3" };

/**
 * Makes a shareable audit for a business that has not signed up. Each prompt is asked several
 * times on every assistant, which costs real money, so the form says how much it is about to ask.
 */
export function NewAudit({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(EMPTY);
  const [prompts, setPrompts] = useState([""]);
  const asked = prompts.map((prompt) => prompt.trim()).filter(Boolean);
  // An empty field is not zero: it is nothing, and the schema says so.
  const samples = text.samples.trim() === "" ? Number.NaN : Number(text.samples);
  const values: AuditFormValues = {
    business_name: text.business_name,
    website: text.website,
    city: text.city,
    region: text.region,
    prompts: asked,
    samples,
  };
  const form$ = useFormErrors(AuditInputSchema, values);
  const create = useMutation({
    mutationFn: () => api.createAudit(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-audits"] });
      onDone();
    },
  });
  const set = (name: keyof typeof EMPTY) => ({
    value: text[name],
    error: form$.error(name),
    onBlur: () => form$.touch(name),
    onChange: (event: { target: { value: string } }) => {
      setText({ ...text, [name]: event.target.value });
      create.reset();
    },
  });
  const answers = Number.isInteger(samples) ? asked.length * samples : 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) create.mutate();
  }

  return (
    <form onSubmit={submit} className="card settings-main" noValidate>
      <div>
        <h3>New audit</h3>
        <p className="small muted">
          A one-off report for a business that has not signed up, read by anyone who has its link
          for 30 days.
        </p>
      </div>
      <div className="field-grid">
        <Field label="Business name" required maxLength={120} {...set("business_name")} />
        <Field label="Website" placeholder="joespizza.com" maxLength={200} {...set("website")} />
        <Field label="City" required maxLength={80} {...set("city")} />
        <Field label="State or region" maxLength={80} {...set("region")} />
      </div>
      {prompts.map((prompt, index) => (
        <Field
          // biome-ignore lint/suspicious/noArrayIndexKey: prompts are only added at the end
          key={index}
          label={`Prompt ${index + 1}`}
          placeholder="Who makes the best pizza in Raleigh?"
          maxLength={200}
          value={prompt}
          // The schema speaks of the prompts as one list, so its message goes under the first.
          error={index === 0 ? form$.error("prompts") : undefined}
          onBlur={() => form$.touch("prompts")}
          onChange={(event) => {
            setPrompts(prompts.map((old, at) => (at === index ? event.target.value : old)));
            create.reset();
          }}
        />
      ))}
      {prompts.length < AUDIT_MAX_PROMPTS && (
        <button type="button" className="secondary" onClick={() => setPrompts([...prompts, ""])}>
          Add another prompt
        </button>
      )}
      <Field
        label="Times each prompt is asked"
        hint={`1 to ${AUDIT_MAX_SAMPLES}. More gives a steadier figure and costs more.`}
        inputMode="numeric"
        required
        {...set("samples")}
      />
      <p className="small muted" role="status">
        {answers > 0
          ? `This asks every assistant for ${answers} ${answers === 1 ? "answer" : "answers"}, and each one is paid for.`
          : "Each answer an assistant gives is paid for."}
      </p>
      <div className="head-actions">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Making" : "Make audit"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}
