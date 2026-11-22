/**
 * The campaign categories the API accepts on POST /metadata. Stored metadata
 * may still hold older free text values; reads return them unchanged.
 */
export const CATEGORIES = [
  'flood',
  'earthquake',
  'storm',
  'wildfire',
  'drought',
  'epidemic',
  'food_security',
  'shelter',
  'reforestation',
  'renewable_energy',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];
