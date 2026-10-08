import {
  type CountryCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from "libphonenumber-js/min";
import type { z } from "zod";

/**
 * What a person types into a form, tidied and checked. The schemas in `schemas.ts` use these, so
 * the API and the web app refuse the same things with the same words.
 */

/**
 * Whether a two-letter code names a country. Deliberately not a type guard: a location's country
 * stays a plain string, as its row has it.
 */
export function isCountry(code: string): boolean {
  return isSupportedCountry(code);
}

/**
 * A phone number as it is stored: with its country code and nothing else ("+19195550100"). A
 * number typed without a country code is read as one in `country`. Null when it is not a phone
 * number there.
 */
export function normalizePhone(typed: string, country: string): string | null {
  if (!isCountry(country)) return null;
  const parsed = parsePhoneNumberFromString(typed, country as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * A phone number as it is shown: the way it is written in `country` when it is a number there,
 * with its country code when it is from somewhere else. Anything that is not yet a whole number,
 * which is most of what is typed into a field, comes back as it was.
 */
export function formatPhone(value: string, country: string): string {
  if (!isCountry(country)) return value;
  const parsed = parsePhoneNumberFromString(value, country as CountryCode);
  if (!parsed?.isValid()) return value;
  return parsed.country === country ? parsed.formatNational() : parsed.formatInternational();
}

/**
 * A website as it is stored: with its scheme, which people rarely type. Null when it is not an
 * address on the public web.
 */
export function normalizeWebsite(typed: string): string | null {
  if (/\s/.test(typed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A name with a dot in it and a suffix of letters: "localhost" and bare words are not sites.
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname)) return null;
  return withScheme;
}

/** The postal codes whose form is checked exactly. Any other country's only has to look like one. */
const POSTAL: Record<
  string,
  { pattern: RegExp; message: string; tidy?: (code: string) => string }
> = {
  US: { pattern: /^\d{5}(-\d{4})?$/, message: "Enter a 5-digit ZIP code" },
  CA: {
    pattern: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/,
    message: "Enter a postal code, like K1A 0B1",
    tidy: (code) => `${code.slice(0, 3)} ${code.slice(-3)}`,
  },
};

/** A postal code as it is stored, or the reason it cannot be one in `country`. */
export function normalizePostalCode(
  typed: string,
  country: string,
): { code: string } | { error: string } {
  const code = typed.toUpperCase();
  const known = POSTAL[country];
  if (!known) {
    return /^[A-Z0-9][A-Z0-9 -]{1,10}$/.test(code) ? { code } : { error: "Enter a postal code" };
  }
  if (!known.pattern.test(code)) return { error: known.message };
  return { code: known.tidy ? known.tidy(code) : code };
}

/**
 * What is wrong with a form's values, one message per field: the first the schema gives for each.
 * Empty when the values would be accepted.
 */
export function fieldErrors(schema: z.ZodType, values: unknown): Record<string, string> {
  const result = schema.safeParse(values);
  const errors: Record<string, string> = {};
  if (result.success) return errors;
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "");
    errors[field] ??= issue.message;
  }
  return errors;
}
