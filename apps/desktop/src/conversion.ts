import { normalizeRelayUrl } from "./relay";

const HOST_CAMPAIGN_STORAGE_KEY = "silverfish.host-campaign.v1";
const CAMPAIGN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type ConversionEventType = "download_clicked" | "app_activated" | "host_setup_opened" | "room_started" | "checkout_opened";

export async function createGuestCampaign(relayUrl: string): Promise<string> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/conversions/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "guest_room" }),
  });
  if (!response.ok) throw new Error("Could not prepare download attribution");
  const body = await response.json() as { campaign?: unknown };
  if (typeof body.campaign !== "string" || !CAMPAIGN_PATTERN.test(body.campaign)) {
    throw new Error("The conversion service returned an invalid campaign");
  }
  return body.campaign;
}

export function saveHostCampaign(campaign: string): boolean {
  if (!CAMPAIGN_PATTERN.test(campaign)) return false;
  try {
    window.localStorage.setItem(HOST_CAMPAIGN_STORAGE_KEY, campaign);
    return true;
  } catch {
    return false;
  }
}

export function getHostCampaign(): string | undefined {
  try {
    const campaign = window.localStorage.getItem(HOST_CAMPAIGN_STORAGE_KEY);
    return campaign && CAMPAIGN_PATTERN.test(campaign) ? campaign : undefined;
  } catch {
    return undefined;
  }
}

export function recordConversionEvent(
  relayUrl: string,
  campaign: string | undefined,
  eventType: ConversionEventType,
  credential?: string,
): void {
  if (!campaign || !CAMPAIGN_PATTERN.test(campaign)) return;
  void fetch(`${normalizeRelayUrl(relayUrl)}/api/conversions/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign, eventType, credential }),
    keepalive: true,
  }).catch(() => undefined);
}
