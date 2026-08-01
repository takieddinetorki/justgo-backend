/**
 * Status vocabulary is CONTRACT — clients render it and the apps' models
 * mirror it. The transition RULES stay private in domain/ (§5).
 */
export type QuoteStatus = 'pending' | 'quoted' | 'rejected' | 'accepted' | 'refused' | 'closed';

export type RequestStatus =
  | 'pending'
  | 'awaiting_client'
  | 'accepted'
  | 'refused'
  | 'expired'
  | 'cancelled';
