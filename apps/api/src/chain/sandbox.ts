import { guardedVaultAbi, guardedVaultBytecode } from '@chainguard/shared/abi';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { Logger } from '../logger';

/** Deterministic deployment proxy (Arachnid) — predeployed by anvil and present on Sepolia. */
export const CREATE2_FACTORY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
/** Its runtime code. anvil_reset wipes anvil's genesis predeploys, so we put it back. */
const CREATE2_FACTORY_CODE: Hex =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
export const SANDBOX_CHAIN_ID = 31_337;
const SALT = keccak256(toHex('chainguard-sandbox-vault-v1'));

export const SANDBOX_PARAMS = {
  limit: parseEther('20'),
  windowSeconds: 3_600n,
  timelockSeconds: 60n,
  funding: parseEther('100'),
} as const;

export interface SandboxAccounts {
  admin: HDAccount;
  guardian: HDAccount;
  ops: HDAccount;
  attacker: HDAccount;
  treasury: HDAccount;
}

export interface SandboxOptions {
  rpcUrl: string;
  mnemonic: string;
  forkUrl?: string | undefined;
}

/**
 * The local anvil chain behind "Simulate attack". Every reset redeploys the vault
 * through CREATE2 with the same salt and constructor args, so it always lands at
 * the same address and the watcher never needs to be told about a new contract.
 */
export class Sandbox {
  readonly accounts: SandboxAccounts;
  readonly client: PublicClient<Transport, Chain>;
  readonly vaultAddress: Address;
  readonly #initCode: Hex;

  constructor(
    private readonly opts: SandboxOptions,
    private readonly log: Logger,
  ) {
    const at = (addressIndex: number) => mnemonicToAccount(opts.mnemonic, { addressIndex });
    this.accounts = { admin: at(0), guardian: at(1), ops: at(2), attacker: at(3), treasury: at(4) };
    this.client = createPublicClient({
      chain: foundry,
      transport: http(opts.rpcUrl, { retryCount: 0 }),
      pollingInterval: 250,
    });

    const { admin, guardian, ops, attacker } = this.accounts;
    this.#initCode = encodeDeployData({
      abi: guardedVaultAbi,
      bytecode: guardedVaultBytecode,
      args: [
        admin.address,
        guardian.address,
        // The attacker holds WITHDRAWER_ROLE from the start: the scenario is a leaked key.
        [ops.address, attacker.address],
        SANDBOX_PARAMS.limit,
        SANDBOX_PARAMS.windowSeconds,
        SANDBOX_PARAMS.timelockSeconds,
      ],
    });
    this.vaultAddress = getContractAddress({
      from: CREATE2_FACTORY,
      opcode: 'CREATE2',
      salt: SALT,
      bytecode: this.#initCode,
    });
  }

  /** Addresses the watcher should treat as normal operators of the sandbox vault. */
  get knownCallers(): Address[] {
    const { admin, guardian, ops } = this.accounts;
    return [admin.address, guardian.address, ops.address];
  }

  wallet(account: Account): WalletClient<Transport, Chain, Account> {
    return createWalletClient({ account, chain: foundry, transport: http(this.opts.rpcUrl) });
  }

  /** Waits for anvil to answer and refuses to run against anything but a local dev chain. */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const chainId = await this.client.getChainId();
        if (chainId !== SANDBOX_CHAIN_ID) {
          throw new Error(
            `sandbox RPC reports chain ${chainId}; expected ${SANDBOX_CHAIN_ID} (anvil)`,
          );
        }
        return;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('sandbox RPC reports')) throw err;
        if (Date.now() > deadline)
          throw new Error(`sandbox RPC not reachable at ${this.opts.rpcUrl}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      return (await this.client.getChainId()) === SANDBOX_CHAIN_ID;
    } catch {
      return false;
    }
  }

  async isDeployed(): Promise<boolean> {
    const code = await this.client.getCode({ address: this.vaultAddress });
    return !!code && code !== '0x';
  }

  /** Deploys and funds the vault if the chain does not have it yet (fresh anvil). */
  async ensureDeployed(): Promise<void> {
    if (await this.isDeployed()) return;
    await this.deployAndFund();
  }

  /** Back to a clean chain (or a fresh fork of the upstream network). */
  async reset(): Promise<void> {
    const params = this.opts.forkUrl ? [{ forking: { jsonRpcUrl: this.opts.forkUrl } }] : [];
    await this.client.request({ method: 'anvil_reset', params } as never);
    const factoryCode = await this.client.getCode({ address: CREATE2_FACTORY });
    if (!factoryCode || factoryCode === '0x') {
      await this.client.request({
        method: 'anvil_setCode',
        params: [CREATE2_FACTORY, CREATE2_FACTORY_CODE],
      } as never);
    }
    // Fresh forks start with whatever balances the dev accounts have upstream.
    for (const account of Object.values(this.accounts)) {
      await this.client.request({
        method: 'anvil_setBalance',
        params: [account.address, toHex(parseEther('1000'))],
      } as never);
    }
    await this.waitUntilReady(10_000);
  }

  async deployAndFund(): Promise<{ deployTx: Hex; fundTx: Hex }> {
    const admin = this.wallet(this.accounts.admin);
    const deployTx = await admin.sendTransaction({
      to: CREATE2_FACTORY,
      data: concatHex([SALT, this.#initCode]),
      gas: 3_000_000n,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash: deployTx });
    if (receipt.status !== 'success' || !(await this.isDeployed())) {
      throw new Error('sandbox vault deployment failed');
    }
    const fundTx = await admin.writeContract({
      address: this.vaultAddress,
      abi: guardedVaultAbi,
      functionName: 'deposit',
      value: SANDBOX_PARAMS.funding,
    });
    await this.client.waitForTransactionReceipt({ hash: fundTx });
    this.log.info({ vault: this.vaultAddress }, 'sandbox vault deployed and funded');
    return { deployTx, fundTx };
  }

  /** Resolves on the next block, so a burst lands in one block window. */
  async nextBlock(timeoutMs = 15_000): Promise<bigint> {
    const start = await this.client.getBlockNumber({ cacheTime: 0 });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = await this.client.getBlockNumber({ cacheTime: 0 });
      if (n > start) return n;
      if (Date.now() > deadline) throw new Error('sandbox chain is not producing blocks');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
