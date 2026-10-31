/**
 * What each `secret_*` tool gives codemode scripts: its `outputSchema`, which Pi's codemode hands a
 * script as the call's value instead of the model-facing text. The value is the result's details,
 * so a script sees how to reference each Secret, never its value. Keys are snake_case, and a field
 * that does not apply to an outcome is absent.
 */
import { Type, type Static, type TSchema } from "typebox";

const Name = Type.String({ description: "The Secret Name" });

const Reference = Type.String({
  description: "The Secret Reference to write in other tool arguments; never the value",
});

const Env = Type.String({
  description:
    "The environment variable shell commands read the Secret from: the Secret Name after the PI_SECRET_ prefix, without the leading $",
});

const ExpiresAt = Type.String({
  description: "When the Secret Lifetime ends, as an ISO time",
});

/** How to use a Secret this session now holds; present only on an outcome that holds one. */
const usage = {
  reference: Type.Optional(Reference),
  env: Type.Optional(Env),
  expires_at: Type.Optional(ExpiresAt),
};

/** One name `secret_ask` asked for, and how it came out. */
export const AskOutcomeSchema = Type.Object(
  {
    name: Name,
    status: Type.Union(
      [Type.Literal("provided"), Type.Literal("skipped"), Type.Literal("cancelled")],
      {
        description:
          "provided: entered and held; skipped: the user left it empty; cancelled: the user cancelled the Secret Request",
      },
    ),
    ...usage,
  },
  { additionalProperties: false },
);

/** One Secret Grant `secret_ask_grant` asked for, and how it came out. */
export const GrantOutcomeSchema = Type.Object(
  {
    name: Name,
    status: Type.Union(
      [
        Type.Literal("granted"),
        Type.Literal("denied"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
      ],
      {
        description:
          "granted: approved, read, and held; denied: the user denied it; failed: it could not be described or read (see error); cancelled: the user cancelled the Grant Request",
      },
    ),
    locator: Type.String({
      description:
        "The Secret Locator: the Secret Provider's own form of it once granted, else as requested",
    }),
    ...usage,
    error: Type.Optional(Type.String({ description: "Why a failed grant failed" })),
    warning: Type.Optional(
      Type.String({
        description:
          "A risk with the value, such as being too short to redact without hiding unrelated output",
      }),
    ),
  },
  { additionalProperties: false },
);

/** One Secret `secret_list` says this session can use. */
export const HeldOutcomeSchema = Type.Object(
  {
    name: Name,
    status: Type.Literal("held", { description: "This session can use the Secret" }),
    reference: Reference,
    env: Env,
    expires_at: Type.Optional(
      Type.String({
        description:
          "When the Secret Lifetime ends, as an ISO time; absent when another session in this process holds it",
      }),
    ),
    locator: Type.Optional(
      Type.String({ description: "The Secret Locator a granted Secret is read from at each use" }),
    ),
  },
  { additionalProperties: false },
);

/** The typed Secret `secret_save` was asked to save, and how it came out. */
export const SaveOutcomeSchema = Type.Object(
  {
    name: Name,
    status: Type.Union([Type.Literal("saved"), Type.Literal("denied"), Type.Literal("cancelled")], {
      description:
        "saved: saved and now read from its Secret Provider at each use; denied: the user denied the save; cancelled: the user cancelled it",
    }),
    locator: Type.Optional(
      Type.String({ description: "The Secret Locator of the new item or key, once saved" }),
    ),
    ...usage,
  },
  { additionalProperties: false },
);

/** What `secret_forget` did with one name. */
export const ForgetOutcomeSchema = Type.Object(
  {
    name: Name,
    status: Type.Union([Type.Literal("forgotten"), Type.Literal("not_held")], {
      description: "forgotten: no longer held; not_held: this session did not hold it",
    }),
  },
  { additionalProperties: false },
);

const SecretProviderId = Type.String({
  description: "The Secret Provider's id, such as 1password",
});
const Vault = Type.String({ description: "The vault holding the item" });

/** An item or field a Secret Provider search found; never a value. */
export const AvailableEntrySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("item", {
        description: "An item; list its fields with secret_list item=<id>",
      }),
      provider: SecretProviderId,
      id: Type.String({ description: "The item's id, to pass as secret_list item" }),
      title: Type.String({ description: "The item's title" }),
      vault: Vault,
      category: Type.String({ description: "The item's category" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("field", {
        description: "A field of one item, to request with secret_ask_grant",
      }),
      provider: SecretProviderId,
      item: Type.String({ description: "The title of the item holding the field" }),
      vault: Vault,
      label: Type.String({ description: "The field's label" }),
      type: Type.String({ description: "The field's type, such as concealed" }),
      locator: Type.String({
        description: "The Secret Locator to request the field by with secret_ask_grant",
      }),
    },
    { additionalProperties: false },
  ),
]);

/** A tool's value: one outcome per Secret it handled. */
const secretsOutput = <T extends TSchema>(outcome: T, description: string) =>
  Type.Object({ secrets: Type.Array(outcome, { description }) }, { additionalProperties: false });

export const SecretAskOutputSchema = secretsOutput(
  AskOutcomeSchema,
  "One per name asked for, in the order asked",
);

export const SecretAskGrantOutputSchema = secretsOutput(
  GrantOutcomeSchema,
  "One per Secret Grant asked for, in the order asked",
);

export const SecretListOutputSchema = Type.Object(
  {
    secrets: Type.Array(HeldOutcomeSchema, {
      description: "The held Secrets that match, by Secret Name",
    }),
    available: Type.Optional(
      Type.Array(AvailableEntrySchema, {
        description:
          "Secret Provider items or fields that match, up to limit per Secret Provider; absent when none",
      }),
    ),
    notes: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Searches that matched more than limit, or Secret Providers that could not be searched; absent when none",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SecretSaveOutputSchema = secretsOutput(
  SaveOutcomeSchema,
  "The one Secret asked to be saved",
);

export const SecretForgetOutputSchema = secretsOutput(
  ForgetOutcomeSchema,
  "One per name, in the order given",
);

export type AskOutcome = Static<typeof AskOutcomeSchema>;
export type GrantOutcome = Static<typeof GrantOutcomeSchema>;
export type HeldOutcome = Static<typeof HeldOutcomeSchema>;
export type SaveOutcome = Static<typeof SaveOutcomeSchema>;
export type ForgetOutcome = Static<typeof ForgetOutcomeSchema>;
/** One Secret's outcome in a `secret_*` result's details and value. */
export type SecretOutcome = AskOutcome | GrantOutcome | HeldOutcome | SaveOutcome | ForgetOutcome;
