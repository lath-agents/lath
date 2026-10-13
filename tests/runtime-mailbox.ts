import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AppendPolicy, Bytes32, LathClient, Mailbox, allowListRoot, hex, idFromString, sha256 } from "../sdk/src";
import { AgentRuntime, ChatRequest, ChatResult, ChatTransport, DelegateDefinition } from "../runtime/src";

/**
 * The runtime's session mailbox. Created with no senders, the SDK would default it to
 * `AppendPolicy.Anyone` and any funded key could append a cell — each append advancing the
 * owner's `seq` and folding into its `head`. An allow-list of the first parent to delegate would
 * fix the root to that parent and refuse every later orchestrator. So it
 * is `OwnerOnly`, created at registration, and a parent delivers the mandate with the **child's**
 * key (`deliverMandate`) — the one signer the program admits under every append policy, so any
 * number of parents can delegate. `mailboxSenders` stays the opt-in allow-list for senders
 * outside the process.
 *
 * Node-only: a stub client records the `create_struct` and `create_cell` calls the runtime makes
 * and applies the program's append check (`create_cell_inner`, programs/lath/src/lib.rs) to each
 * cell — `OwnerOnly` admits the agent's authority, `AllowList` the authority or a key whose
 * sorted-pair path reaches the header's root, `Anyone` everyone — so a delivery the chain would
 * refuse is refused here too.
 */

const INBOX = Mailbox.id("runtime-inbox");

type Header = { appendPolicy: AppendPolicy; policyRef?: Uint8Array };
type CreateStruct = Header & { ownerId: string; structId: string };
type Cell = { signer: string; ownerId: string; structId: string; keySlot: string; proof: number };

/** The program's `merkle_root_of`: sorted pairs, an empty path is the leaf itself. */
function merkleRootOf(leaf: Uint8Array, proof: Uint8Array[]): Uint8Array {
  let node = leaf;
  for (const sibling of proof) {
    node = Buffer.compare(node, sibling) <= 0 ? sha256(node, sibling) : sha256(sibling, node);
  }
  return node;
}

/** The structure half of `LathClient`, recorded. `headers` is what is already on chain. */
class StructChain {
  readonly structs: CreateStruct[] = [];
  /** Cells the program's append check admitted. */
  readonly cells: Cell[] = [];
  readonly headers = new Map<string, Header>();
  /** Each agent's registered authority, the `current.authority` the check compares against. */
  readonly owners = new Map<string, PublicKey>();

  client(authority: PublicKey): LathClient {
    const chain = this;
    return {
      authority: { publicKey: authority },
      async getHeader(ownerId: Bytes32, structId: Bytes32) {
        const header = chain.headers.get(`${hex(ownerId)}:${hex(structId)}`);
        return header ? { account: {}, header } : null;
      },
      async createStruct(ownerId: Bytes32, p: { structId: Bytes32 } & Header) {
        chain.structs.push({
          ownerId: hex(ownerId),
          structId: hex(p.structId),
          appendPolicy: p.appendPolicy,
          policyRef: p.policyRef,
        });
        chain.headers.set(`${hex(ownerId)}:${hex(p.structId)}`, {
          appendPolicy: p.appendPolicy,
          policyRef: p.policyRef,
        });
        return { signature: "sig" };
      },
      async createCell(
        ownerId: Bytes32,
        structId: Bytes32,
        input: { keySlot: Uint8Array; allowListProof?: Uint8Array[] }
      ) {
        const header = chain.headers.get(`${hex(ownerId)}:${hex(structId)}`);
        if (!header) throw new Error("no header");
        const owner = chain.owners.get(hex(ownerId))!;
        const isOwner = owner.equals(authority);
        if (header.appendPolicy === AppendPolicy.OwnerOnly && !isOwner) throw new Error("Unauthorized");
        if (
          header.appendPolicy === AppendPolicy.AllowList &&
          !isOwner &&
          hex(merkleRootOf(sha256(authority.toBytes()), input.allowListProof ?? [])) !== hex(header.policyRef!)
        ) {
          throw new Error("AppendNotAllowed");
        }
        chain.cells.push({
          signer: authority.toBase58(),
          ownerId: hex(ownerId),
          structId: hex(structId),
          keySlot: hex(input.keySlot),
          proof: input.allowListProof?.length ?? -1,
        });
        // Stops a delegation here: what follows the send is the parent's own records, which this
        // suite does not stand up.
        throw new Error("stop after the send");
      },
    } as unknown as LathClient;
  }

  mailboxOf(ownerId: Bytes32): CreateStruct | undefined {
    return this.structs.find((s) => s.ownerId === hex(ownerId) && s.structId === hex(INBOX));
  }
}

const idle: ChatTransport = {
  async chat(_req: ChatRequest): Promise<ChatResult> {
    throw new Error("no model call in this suite");
  },
};

function runtimeFor(chain: StructChain, name: string, key: PublicKey, extra: { mailboxSenders?: PublicKey[] } = {}) {
  chain.owners.set(hex(idFromString(name)), key);
  return new AgentRuntime({
    client: chain.client(key),
    agentId: idFromString(name),
    transport: idle,
    policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000 },
    publishPolicy: false,
    now: () => 1_700_000_000_000,
    ...extra,
  });
}

/** A child factory the way the console builds one: a fresh runtime over the same agent each time. */
function childSpec(chain: StructChain, childKey: PublicKey): DelegateDefinition & { last?: AgentRuntime } {
  const spec: DelegateDefinition & { last?: AgentRuntime } = {
    name: "child",
    create: () => {
      const child = runtimeFor(chain, "child", childKey);
      // Registration is the chain's business, not this suite's: only the structures it creates.
      child.ensureRegistered = async () => {
        await child.ensureStructures();
        return false;
      };
      spec.last = child;
      return child;
    },
  };
  return spec;
}

/** Runs `delegateTo` up to the mailbox send and returns what stopped it. */
async function delegate(parent: AgentRuntime, spec: DelegateDefinition, taskId: string): Promise<string> {
  try {
    await parent.delegateTo(spec, "do it", taskId, parent.authority);
  } catch (e: any) {
    return e.message;
  }
  return "";
}

describe("the runtime's session mailbox is never open to anyone", () => {
  it("creates an OwnerOnly mailbox at registration, and never an Anyone header", async () => {
    const chain = new StructChain();
    const runtime = runtimeFor(chain, "solo", Keypair.generate().publicKey);
    await runtime.ensureStructures();

    const created = chain.mailboxOf(runtime.agentId);
    assert.isDefined(created, "created eagerly: an OwnerOnly header has no root to wait for");
    assert.equal(created!.appendPolicy, AppendPolicy.OwnerOnly);
    assert.notInclude(
      chain.structs.map((s) => s.appendPolicy),
      AppendPolicy.Anyone
    );
  });

  it("commits the configured senders as the mailbox's allow-list root, and admits exactly them", async () => {
    const chain = new StructChain();
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const runtime = runtimeFor(chain, "configured", Keypair.generate().publicKey, { mailboxSenders: [a, b] });
    await runtime.ensureStructures();

    const created = chain.mailboxOf(runtime.agentId);
    assert.isDefined(created);
    assert.equal(created!.appendPolicy, AppendPolicy.AllowList);
    assert.equal(hex(created!.policyRef!), hex(allowListRoot([a, b])));

    // An external sender on the list proves its way to the committed root.
    let stopped = "";
    await runtime.mailbox!.send(chain.client(b), "hello").catch((e) => (stopped = e.message));
    assert.equal(stopped, "stop after the send", "the program's check admitted the listed sender");
    // One off the list is refused before a transaction is built.
    const stranger = Keypair.generate().publicKey;
    await runtime.mailbox!.send(chain.client(stranger), "hello").catch((e) => (stopped = e.message));
    assert.match(stopped, /not on this mailbox's allow list/);
  });

  it("lets two different parents both deliver into the same child, signed by the child", async () => {
    // An allow-list mailbox would let the first parent fix the child's allow-list root, so a second
    // orchestrator picking the same agent would be refused `AppendNotAllowed` on every step.
    const chain = new StructChain();
    const childKey = Keypair.generate().publicKey;
    const spec = childSpec(chain, childKey);
    const [keyA, keyB] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const parentA = runtimeFor(chain, "parent-a", keyA);
    const parentB = runtimeFor(chain, "parent-b", keyB);

    assert.equal(await delegate(parentA, spec, "task-a"), "stop after the send", "parent A delivered");
    assert.equal(await delegate(parentB, spec, "task-b"), "stop after the send", "parent B delivered");

    const childId = hex(spec.last!.agentId);
    assert.equal(chain.mailboxOf(spec.last!.agentId)!.appendPolicy, AppendPolicy.OwnerOnly);
    assert.deepEqual(chain.cells, [
      // `key_slot` still names the parent — the field `fromSender` and the hand-off check read —
      // and the owner branch of the check needs no proof.
      {
        signer: childKey.toBase58(),
        ownerId: childId,
        structId: hex(INBOX),
        keySlot: hex(sha256(keyA.toBytes())),
        proof: -1,
      },
      {
        signer: childKey.toBase58(),
        ownerId: childId,
        structId: hex(INBOX),
        keySlot: hex(sha256(keyB.toBytes())),
        proof: -1,
      },
    ]);
  });

  it("still delivers into an older one-parent allow-list header", async () => {
    // The program admits the owner under `AllowList` whatever the root, so a mailbox fixed to
    // some other parent needs no fallback to the parent's key.
    const chain = new StructChain();
    const childKey = Keypair.generate().publicKey;
    const spec = childSpec(chain, childKey);
    const earlier = Keypair.generate().publicKey;
    chain.headers.set(`${hex(idFromString("child"))}:${hex(INBOX)}`, {
      appendPolicy: AppendPolicy.AllowList,
      policyRef: allowListRoot([earlier]),
    });
    const parent = runtimeFor(chain, "parent", Keypair.generate().publicKey);

    assert.equal(await delegate(parent, spec, "task-1"), "stop after the send");
    assert.isUndefined(chain.mailboxOf(spec.last!.agentId), "the header on chain was not rewritten");
    assert.equal(chain.cells[0].signer, childKey.toBase58());
  });

  it("leaves a legacy Anyone header as it was created, and delivers into it", async () => {
    // What `OwnerOnly` at registration cannot reach: an agent whose mailbox was created `Anyone`
    // keeps that header, because `ensureCreated` finds it and writes nothing.
    const chain = new StructChain();
    const childKey = Keypair.generate().publicKey;
    const spec = childSpec(chain, childKey);
    chain.headers.set(`${hex(idFromString("child"))}:${hex(INBOX)}`, { appendPolicy: AppendPolicy.Anyone });
    const parent = runtimeFor(chain, "parent", Keypair.generate().publicKey);

    assert.equal(await delegate(parent, spec, "task-1"), "stop after the send");
    assert.isUndefined(chain.mailboxOf(spec.last!.agentId));
    assert.equal(chain.headers.get(`${hex(idFromString("child"))}:${hex(INBOX)}`)!.appendPolicy, AppendPolicy.Anyone);
    assert.equal(chain.cells[0].signer, childKey.toBase58());
  });
});
