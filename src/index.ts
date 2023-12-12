import NDK, {
  NDKEvent,
  NDKFilter,
  NDKSubscriptionCacheUsage,
  ProfilePointer,
} from '@nostr-dev-kit/ndk';
import { ndkAdapter } from '@nostr-fetch/adapter-ndk';
import { Elysia, t } from 'elysia';
import { NostrFetcher, normalizeRelayUrlSet } from 'nostr-fetch';
import { nip19 } from 'nostr-tools';

let ndk: NDK;
let fetcher: NostrFetcher;

const FETCH_LIMIT = 20;

const app = new Elysia()
  .onStart(async () => {
    console.log(Bun.env.CONFIG_DIR);
    console.log(Bun.env.PUBKEY);
    console.log(Bun.env.PRIVKEY);
    console.log(Bun.env.BUNKER);
    console.log(Bun.env.OUTBOX);

    /*
    const db = new Database(`${Bun.env.CONFIG_DIR}/lume_v2.db`, {
      create: false,
      readonly: false,
      readwrite: true,
    });
    */

    const explicitRelayUrls = normalizeRelayUrlSet([
      'wss://relay.damus.io',
      'wss://relay.nostr.band',
      'wss://nos.lol',
      'wss://nostr.mutinywallet.com',
    ]);

    // #TODO: user should config outbox relays
    const outboxRelayUrls = normalizeRelayUrlSet(['wss://purplepag.es']);

    // #TODO: user should config blacklist relays
    const blacklistRelayUrls = normalizeRelayUrlSet(['wss://brb.io']);

    ndk = new NDK({
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
  .get('/', () => 'Use Lume to interact with nstation')
  .get('/users/:id/profile', async ({ set, params: { id } }) => {
    let pubkey: string = id;

    if (pubkey.startsWith('npub1')) {
      pubkey = nip19.decode(pubkey).data as string;
    }

    if (pubkey.startsWith('nprofile1')) {
      const decoded = nip19.decode(pubkey).data as ProfilePointer;
      pubkey = decoded.pubkey;
    }

    const user = ndk.getUser({ pubkey });
    const profile = await user.fetchProfile();

    if (!profile) {
      set.status = 404;
      throw new Error('Not found');
    }

    return profile;
  })
  .get('/users/:id/contacts', async ({ set, params: { id } }) => {
    let pubkey: string = id;

    if (pubkey.startsWith('npub1')) {
      pubkey = nip19.decode(pubkey).data as string;
    }

    if (pubkey.startsWith('nprofile1')) {
      const decoded = nip19.decode(pubkey).data as ProfilePointer;
      pubkey = decoded.pubkey;
    }

    const user = ndk.getUser({ pubkey });
    const contacts = [...(await user.follows())].map((user) => user.pubkey);

    if (!contacts) {
      set.status = 404;
      throw new Error('Not found');
    }

    return contacts;
  })
  .get('/events/:id', async ({ set, params: { id } }) => {
    const event = await ndk.fetchEvent(id, {
      cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
    });

    if (!event) {
      set.status = 404;
      throw new Error('Not found');
    }

    return event.rawEvent();
  })
  .get(
    '/events/all',
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
        }
      );

      if (!events) {
        set.status = 404;
        throw new Error('Not found');
      }

      if (body.dedup) {
        for (const event of events) {
          const tags = event.tags.filter((el) => el[0] === 'e');
          if (tags && tags.length > 0) {
            const rootId = tags.filter((el) => el[3] === 'root')[1] ?? tags[0][1];
            if (rootIds.has(rootId)) return dedupQueue.add(event.id);
            rootIds.add(rootId);
          }
        }

        return events
          .filter((event) => !dedupQueue.has(event.id))
          .sort((a, b) => b.created_at - a.created_at);
      }

      return events.sort((a, b) => b.created_at - a.created_at);
    },
    {
      body: t.Object({
        filter: t.String(),
        limit: t.Optional(t.Number()),
        pageParam: t.Number(),
        dedup: t.Optional(t.Boolean()),
      }),
    }
  )
  .post('/events/:id/repost', async ({ set, params: { id } }) => {
    if (!ndk.signer) {
      set.status = 401;
      throw new Error('NDK Signer is required');
    }

    const event = await ndk.fetchEvent(id, {
      cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
    });
    const repost = await event?.repost(true);

    return repost?.rawEvent();
  })
  .post(
    '/events/:id/react',
    async ({ set, params: { id }, body }) => {
      if (!ndk.signer) {
        set.status = 401;
        throw new Error('NDK Signer is required');
      }

      const event = await ndk.fetchEvent(id, {
        cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
      });
      const reaction = await event?.react(body.content ?? '👍');

      return reaction?.rawEvent();
    },
    {
      body: t.Object({
        content: t.String(),
      }),
    }
  )
  .post(
    '/events/:id/zap',
    async ({ set, params: { id }, body }) => {
      if (!ndk.signer) {
        set.status = 401;
        throw new Error('NDK Signer is required');
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
    }
  )
  .post(
    '/events/filter',
    async ({ set, body }) => {
      const filter: NDKFilter = JSON.parse(body.filter);
      const event = await ndk.fetchEvent(filter, {
        cacheUsage: NDKSubscriptionCacheUsage.CACHE_FIRST,
      });

      if (!event) {
        set.status = 404;
        throw new Error('Not found');
      }

      return event.rawEvent();
    },
    {
      body: t.Object({
        filter: t.String(),
      }),
    }
  )
  .post(
    '/events/publish',
    async ({ set, body }) => {
      if (!ndk.signer) {
        set.status = 401;
        throw new Error('NDK Signer is required');
      }

      const event = new NDKEvent(ndk);
      if (body.content) event.content = body.content;
      event.kind = body.kind;
      event.tags = body.tags;

      if (body.rootReplyTo) {
        const rootEvent = await ndk.fetchEvent(body.rootReplyTo);
        if (rootEvent) event.tag(rootEvent, 'root');
      }

      if (body.replyTo) {
        const replyEvent = await ndk.fetchEvent(body.replyTo);
        if (replyEvent) event.tag(replyEvent, 'reply');
      }

      const publish = await event.publish();

      if (!publish) {
        set.status = 500;
        throw new Error('Failed to publish event');
      }

      // return total relays has been successfully publish that event
      return publish.size;
    },
    {
      body: t.Object({
        content: t.String(),
        kind: t.Number(),
        tags: t.Array(t.Array(t.String())),
        replyTo: t.String(),
        rootReplyTo: t.String(),
      }),
    }
  )
  .listen(6090);

export type App = typeof app;
