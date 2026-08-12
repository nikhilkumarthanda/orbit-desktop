import type { DraftProvider, SocialProvider } from "../shared/contracts.js";

export type DestinationId = DraftProvider | SocialProvider;
export type IdentityResolution = "destination-native" | "system-contacts" | "active-account";

export interface DestinationAdapter {
  id: DestinationId;
  label: string;
  kind: "email" | "social";
  resolution: IdentityResolution;
  composeUrl: string;
}

const adapters: Record<DestinationId, DestinationAdapter> = {
  gmail: { id: "gmail", label: "Gmail", kind: "email", resolution: "destination-native", composeUrl: "https://mail.google.com/mail/?view=cm&fs=1" },
  outlook: { id: "outlook", label: "Outlook", kind: "email", resolution: "destination-native", composeUrl: "https://outlook.office.com/mail/deeplink/compose" },
  mail: { id: "mail", label: "Apple Mail", kind: "email", resolution: "system-contacts", composeUrl: "mailto:" },
  linkedin: { id: "linkedin", label: "LinkedIn", kind: "social", resolution: "active-account", composeUrl: "https://www.linkedin.com/feed/" },
  facebook: { id: "facebook", label: "Facebook", kind: "social", resolution: "active-account", composeUrl: "https://www.facebook.com/" },
};

export function destinationAdapter(id: DestinationId) {
  return adapters[id];
}

export function destinationsFor(kind: DestinationAdapter["kind"]) {
  return Object.values(adapters).filter(adapter => adapter.kind === kind);
}
