import React from 'react';
import { ArrowRight, ShieldCheck, Activity, Lock } from 'lucide-react';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24 bg-slate-950 text-white">
      {/* Navbar Status */}
      <div className="z-10 w-full items-center justify-between font-mono text-sm lg:flex">
        <p className="fixed left-0 top-0 flex w-full justify-center border-b border-gray-800 bg-black/50 pb-6 pt-8 backdrop-blur-2xl lg:static lg:w-auto lg:rounded-xl lg:border lg:bg-gray-900 lg:p-4">
          Status: &nbsp; <span className="font-bold text-emerald-500">System Active</span>
        </p>
      </div>

      {/* Hero Section */}
      <div className="relative flex flex-col place-items-center text-center mt-20">
        <div className="mb-8 p-4 bg-emerald-500/10 rounded-full border border-emerald-500/20">
          <ShieldCheck size={48} className="text-emerald-500" />
        </div>
        <h1 className="text-6xl font-bold tracking-tight mb-4 text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">
          ChainGuard
        </h1>
        <p className="text-xl text-slate-400 max-w-2xl">
          Real-time smart contract security.
        </p>
        
        <div className="mt-8 flex gap-4">
            <button className="px-6 py-3 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 transition flex items-center gap-2">
                Connect Wallet <ArrowRight size={18} />
            </button>
            <button className="px-6 py-3 border border-slate-700 rounded-lg font-semibold hover:bg-slate-800 transition text-slate-300">
                View Documentation
            </button>
        </div>
      </div>

      {/* Feature Grid */}
      <div className="mb-32 grid text-center lg:max-w-5xl lg:w-full lg:mb-0 lg:grid-cols-3 lg:text-left gap-8 mt-24">
        <div className="group rounded-lg border border-slate-800 px-5 py-4 transition-colors hover:border-emerald-500/50 hover:bg-slate-900">
          <h2 className="mb-3 text-2xl font-semibold flex items-center gap-2">
            <Activity className="text-emerald-500" size={20}/> Monitoring
          </h2>
          <p className="m-0 text-sm opacity-50 text-slate-400">
            Mempool scanning and event indexing via The Graph & Kafka.
          </p>
        </div>

        <div className="group rounded-lg border border-slate-800 px-5 py-4 transition-colors hover:border-emerald-500/50 hover:bg-slate-900">
          <h2 className="mb-3 text-2xl font-semibold flex items-center gap-2">
             <Lock className="text-emerald-500" size={20}/> Circuit Breaker
          </h2>
          <p className="m-0 text-sm opacity-50 text-slate-400">
            Automated pause functionality and rate limiting per block.
          </p>
        </div>

        <div className="group rounded-lg border border-slate-800 px-5 py-4 transition-colors hover:border-emerald-500/50 hover:bg-slate-900">
          <h2 className="mb-3 text-2xl font-semibold flex items-center gap-2">
             <ShieldCheck className="text-emerald-500" size={20}/> Security
          </h2>
          <p className="m-0 text-sm opacity-50 text-slate-400">
            Formal verification with Foundry and Slither static analysis.
          </p>
        </div>
      </div>
    </main>
  );
}
