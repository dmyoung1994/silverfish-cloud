export interface PlanDefinition {
  id: "free" | "founding_host";
  name: string;
  priceLabel: string;
  priceSuffix?: string;
  tagline: string;
  maxGuests: number;
  roomLifetimeLabel: string;
  features: string[];
}

export const PLANS: Record<"free" | "founding_host", PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceLabel: "$0",
    tagline: "No account required",
    maxGuests: 1,
    roomLifetimeLabel: "60-minute rooms",
    features: ["1 guest", "60-minute rooms", "End-to-end encrypted"],
  },
  founding_host: {
    id: "founding_host",
    name: "Founding Host",
    priceLabel: "$15",
    priceSuffix: "/ month",
    tagline: "Founding rate stays locked while subscribed",
    maxGuests: 8,
    roomLifetimeLabel: "No room time limit",
    features: [
      "Up to 8 guests",
      "No room time limit",
      "End-to-end encrypted",
      "Maintained desktop builds",
      "Early access to hosted features",
    ],
  },
};
