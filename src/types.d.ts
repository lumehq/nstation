import { NDKEvent } from "@nostr-dev-kit/ndk";

export interface NDKCacheUser {
	pubkey: string;
	profile: string | NDKUserProfile;
	createdAt: number;
}

export interface NDKCacheUserProfile extends NDKUserProfile {
	pubkey: string;
}

export interface NDKCacheEvent {
	id: string;
	pubkey: string;
	content: string;
	kind: number;
	createdAt: number;
	relay: string;
	event: string;
}

export interface NDKCacheEventTag {
	id: string;
	eventId: string;
	tag: string;
	value: string;
	tagValue: string;
}

export interface NDKEventWithReplies extends NDKEvent {
	replies: Array<NDKEvent>;
}
