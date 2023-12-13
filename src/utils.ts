import { ProfilePointer } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";

export function getPubkey(str: string) {
	let pubkey: string = str;

	if (pubkey.startsWith("npub1")) {
		pubkey = nip19.decode(pubkey).data as string;
	}

	if (pubkey.startsWith("nprofile1")) {
		const decoded = nip19.decode(pubkey).data as ProfilePointer;
		pubkey = decoded.pubkey;
	}

	return pubkey;
}
