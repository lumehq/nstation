import Database from "bun:sqlite";
import NDK, {
	NDKEvent,
	NDKFilter,
	NDKKind,
	NDKNip46Signer,
	NDKPrivateKeySigner,
	NDKSubscriptionCacheUsage,
	NDKUser,
	NostrEvent,
} from "@nostr-dev-kit/ndk";
import { ndkAdapter } from "@nostr-fetch/adapter-ndk";
import { Elysia, t } from "elysia";
import { NostrFetcher, normalizeRelayUrlSet } from "nostr-fetch";
import { NDKCacheAdapterTauri } from "./cache";
import { NDKEventWithReplies } from "./types";
import { getPubkey } from "./utils";

let ndk: NDK;
let fetcher: NostrFetcher;

const FETCH_LIMIT = 20;
const PORT = 6090;

const app = new Elysia()
	.onStart(async () => {
		console.log(Bun.env.CONFIG_DIR);
		console.log(Bun.env.PUBKEY);
		console.log(Bun.env.PRIVKEY);
		console.log(Bun.env.BUNKER);
		console.log(Bun.env.OUTBOX);

		let db: Database | undefined = undefined;
		if (Bun.env.CONFIG_DIR) {
			db = new Database(`${Bun.env.CONFIG_DIR}/lume_v2.db`, {
				create: false,
				readonly: false,
				readwrite: true,
			});
		}

		const cacheAdapter = db ? new NDKCacheAdapterTauri(db) : undefined;

		const explicitRelayUrls = normalizeRelayUrlSet([
			"wss://relay.damus.io",
			"wss://relay.nostr.band",
			"wss://nos.lol",
			"wss://nostr.mutinywallet.com",
		]);

		// #TODO: user should config outbox relays
		const outboxRelayUrls = normalizeRelayUrlSet(["wss://purplepag.es"]);

		// #TODO: user should config blacklist relays
		const blacklistRelayUrls = normalizeRelayUrlSet(["wss://brb.io"]);

		ndk = new NDK({
			cacheAdapter,
			explicitRelayUrls,
			outboxRelayUrls,
			blacklistRelayUrls,
			enableOutboxModel: false,
			autoConnectUserRelays: true,
			autoFetchUserMutelist: true,
			// clientName: 'Lume',
			// clientNip89: '',
		});

		await ndk.connect(10000);

		// start fetcher instance
		fetcher = NostrFetcher.withCustomPool(ndkAdapter(ndk));
	})
	.get("/", () => "Use Lume to interact with nstation")
	.get("/status", () => ({ status: !!ndk && !!fetcher }))
	.get("/users/:id/profile", async ({ set, params: { id } }) => {
		const pubkey = getPubkey(id);
		const user = ndk.getUser({ pubkey });
		const profile = await user.fetchProfile();

		if (!profile) {
			set.status = 404;
			throw new Error("Not found");
		}

		return { data: profile };
	})
	.get("/users/:id/contacts", async ({ set, params: { id } }) => {
		const pubkey = getPubkey(id);
		const user = ndk.getUser({ pubkey });
		const contacts = [...(await user.follows())].map((user) => user.pubkey);

		if (!contacts) {
			set.status = 404;
			throw new Error("Not found");
		}

		return { data: contacts };
	})
	.get("/users/:id/relays", async ({ set, params: { id } }) => {
		const pubkey = getPubkey(id);
		const user = ndk.getUser({ pubkey });
		const relays = await user.relayList();

		if (!relays) {
			set.status = 404;
			throw new Error("Not found");
		}

		return {
			read: relays.readRelayUrls,
			write: relays.writeRelayUrls,
			both: relays.bothRelayUrls,
		};
	})
	.get("/users/:id/relaymap", async ({ params: { id } }) => {
		const pubkey = getPubkey(id);
		const user = ndk.getUser({ pubkey });
		const contacts = [...(await user.follows())].map((item) => item.pubkey);
		const relays = [...ndk.pool.relays.values()].map((el) => el.url);

		const LIMIT = 1;
		const relayMap = new Map<string, string[]>();
		const relayEvents = fetcher.fetchLatestEventsPerAuthor(
			{
				authors: contacts,
				relayUrls: relays,
			},
			{ kinds: [NDKKind.RelayList] },
			LIMIT,
		);

		for await (const { author, events } of relayEvents) {
			if (events[0]) {
				for (const tag of events[0].tags) {
					const users = relayMap.get(tag[1]);
					if (!users) return relayMap.set(tag[1], [author]);
					return users.push(author);
				}
			}
		}

		return { data: Object.fromEntries(relayMap) };
	})
	.post(
		"/users/:id/follow",
		async ({ set, params: { id }, body }) => {
			if (!ndk.signer) {
				set.status = 401;
				throw new Error("NDK Signer is required");
			}

			const user = ndk.getUser({ pubkey: id });
			const contacts = await user.follows();
			await user.follow(new NDKUser({ pubkey: body.pubkey }), contacts);

			return { status: true };
		},
		{
			body: t.Object({
				pubkey: t.String(),
			}),
		},
	)
	.post(
		"/users/:id/unfollow",
		async ({ set, params: { id }, body }) => {
			if (!ndk.signer) {
				set.status = 401;
				throw new Error("NDK Signer is required");
			}

			const user = ndk.getUser({ pubkey: id });
			const contacts = await user.follows();
			contacts.delete(new NDKUser({ pubkey: body.pubkey }));

			const event = new NDKEvent(ndk);
			event.content = "";
			event.kind = NDKKind.Contacts;
			event.tags = [...contacts].map((item) => [
				"p",
				item.pubkey,
				item.relayUrls?.[0] || "",
				"",
			]);

			return { status: true };
		},
		{
			body: t.Object({
				pubkey: t.String(),
			}),
		},
	)
	.get("/events/:id", async ({ set, params: { id } }) => {
		const event = await ndk.fetchEvent(id, {
			cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
		});

		if (!event) {
			set.status = 404;
			throw new Error("Not found");
		}

		return { data: event.rawEvent() };
	})
	.get("/events/:id/threads", async ({ set, params: { id } }) => {
		const relayUrls = [...ndk.pool.relays.values()].map((item) => item.url);

		const rawEvents = (await fetcher.fetchAllEvents(
			relayUrls,
			{
				kinds: [NDKKind.Text],
				"#e": [id],
			},
			{ since: 0 },
			{ sort: true },
		)) as unknown as NostrEvent[];

		const events = rawEvents.map(
			(event) => new NDKEvent(ndk, event),
		) as NDKEvent[] as NDKEventWithReplies[];

		if (events.length) {
			const replies = new Set();
			for (const event of events) {
				const tags = event.tags.filter(
					(el: string[]) => el[0] === "e" && el[1] !== id,
				);
				if (tags.length > 0) {
					for (const tag of tags) {
						const rootIndex = events.findIndex((el) => el.id === tag[1]);
						if (rootIndex !== -1) {
							const rootEvent = events[rootIndex];
							if (rootEvent?.replies) {
								rootEvent.replies.push(event);
							} else {
								rootEvent.replies = [event];
							}
							replies.add(event.id);
						}
					}
				}
			}

			const cleanEvents = events.filter((ev) => !replies.has(ev.id));
			return { data: cleanEvents };
		}

		return { data: events };
	})
	.get(
		"/events/all",
		async ({ set, body }) => {
			const relays = [...ndk.pool.relays.values()].map((el) => el.url);
			const filter: NDKFilter = JSON.parse(body.filter);

			const rootIds = new Set();
			const dedupQueue = new Set();

			const events = await fetcher.fetchLatestEvents(
				relays,
				filter,
				body.limit || FETCH_LIMIT,
				{
					asOf: body.pageParam === 0 ? undefined : body.pageParam,
				},
			);

			if (!events) {
				set.status = 404;
				throw new Error("Not found");
			}

			if (body.dedup) {
				for (const event of events) {
					const tags = event.tags.filter((el) => el[0] === "e");
					if (tags && tags.length > 0) {
						const rootId =
							tags.filter((el) => el[3] === "root")[1] ?? tags[0][1];
						if (rootIds.has(rootId)) return dedupQueue.add(event.id);
						rootIds.add(rootId);
					}
				}

				return events
					.filter((event) => !dedupQueue.has(event.id))
					.sort((a, b) => b.created_at - a.created_at);
			}

			return { data: events.sort((a, b) => b.created_at - a.created_at) };
		},
		{
			body: t.Object({
				filter: t.String(),
				limit: t.Optional(t.Number()),
				pageParam: t.Number(),
				dedup: t.Optional(t.Boolean()),
			}),
		},
	)
	.post("/events/:id/repost", async ({ set, params: { id } }) => {
		if (!ndk.signer) {
			set.status = 401;
			throw new Error("NDK Signer is required");
		}

		const event = await ndk.fetchEvent(id, {
			cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
		});
		const repost = await event?.repost(true);

		return { data: repost?.rawEvent() };
	})
	.post(
		"/events/:id/react",
		async ({ set, params: { id }, body }) => {
			if (!ndk.signer) {
				set.status = 401;
				throw new Error("NDK Signer is required");
			}

			const event = await ndk.fetchEvent(id, {
				cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
			});
			const reaction = await event?.react(body.content ?? "👍");

			return { data: reaction?.rawEvent() };
		},
		{
			body: t.Object({
				content: t.String(),
			}),
		},
	)
	.post(
		"/events/:id/zap",
		async ({ set, params: { id }, body }) => {
			if (!ndk.signer) {
				set.status = 401;
				throw new Error("NDK Signer is required");
			}

			const event = await ndk.fetchEvent(id, {
				cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
			});

			const invoice = await event?.zap(body.amount, body.message);

			return { invoice: invoice };
		},
		{
			body: t.Object({
				amount: t.Number(),
				message: t.String(),
			}),
		},
	)
	.get(
		"/events/filter",
		async ({ set, body }) => {
			const filter: NDKFilter = JSON.parse(body.filter);
			const event = await ndk.fetchEvent(filter, {
				cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
			});

			if (!event) {
				set.status = 404;
				throw new Error("Not found");
			}

			return { data: event.rawEvent() };
		},
		{
			body: t.Object({
				filter: t.String(),
			}),
		},
	)
	.post(
		"/events/publish",
		async ({ set, body }) => {
			if (!ndk.signer) {
				set.status = 401;
				throw new Error("NDK Signer is required");
			}

			const event = new NDKEvent(ndk);
			if (body.content) event.content = body.content;
			event.kind = body.kind;
			event.tags = body.tags;

			if (body.rootReplyTo) {
				const rootEvent = await ndk.fetchEvent(body.rootReplyTo);
				if (rootEvent) event.tag(rootEvent, "root");
			}

			if (body.replyTo) {
				const replyEvent = await ndk.fetchEvent(body.replyTo);
				if (replyEvent) event.tag(replyEvent, "reply");
			}

			const publish = await event.publish();

			if (!publish) {
				set.status = 500;
				throw new Error("Failed to publish event");
			}

			// return total relays has been successfully publish that event
			return {
				id: event.id,
				seens: [...publish.values()].map((item) => item.url),
			};
		},
		{
			body: t.Object({
				content: t.String(),
				kind: t.Number(),
				tags: t.Array(t.Array(t.String())),
				replyTo: t.String(),
				rootReplyTo: t.String(),
			}),
		},
	)
	.post(
		"/signer",
		async ({ body }) => {
			if (body.bunker) {
				const localSignerPrivkey = body.privkey;
				const localSigner = new NDKPrivateKeySigner(localSignerPrivkey);

				const bunker = new NDK({
					explicitRelayUrls: [
						"wss://relay.nsecbunker.com",
						"wss://nostr.vulpem.com",
					],
				});
				await bunker.connect();

				const remoteSigner = new NDKNip46Signer(
					bunker,
					body.pubkey,
					localSigner,
				);
				await remoteSigner.blockUntilReady();

				// update signer
				ndk.signer = remoteSigner;
			}

			const privkeySigner = new NDKPrivateKeySigner(body.privkey);
			// update signer
			ndk.signer = privkeySigner;

			return { readyToSign: true };
		},
		{
			body: t.Object({
				privkey: t.String(),
				pubkey: t.String(),
				bunker: t.Optional(t.Boolean()),
				token: t.Optional(t.String()),
			}),
		},
	)
	.listen(PORT);

export type App = typeof app;
