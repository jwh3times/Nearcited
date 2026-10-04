import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ErrorNote } from "../components/ErrorNote";
import { api } from "../lib/api";

export function Onboarding() {
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createOrganization(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <section className="page-narrow">
      <h1>Name your organization</h1>
      <p className="lede">
        The business or agency these locations belong to. Teammates you add later will see
        everything under it.
      </p>
      <form onSubmit={submit} className="stack">
        <label>
          Organization name
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating organization" : "Create organization"}
        </button>
        <ErrorNote error={create.error} />
      </form>
    </section>
  );
}
