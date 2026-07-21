"use client";

import { AudioPlayer } from "@/components/AudioPlayer";
import { CameraFeed } from "@/components/CameraFeed";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 py-16">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        {/* Wordmark */}
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-50">
            Cadence <span className="text-violet-400">AI</span>
          </h1>
          <p className="text-sm text-neutral-500">
            Hands-free choreography IDE · IBM AI Builders Challenge
          </p>
        </div>

        {/* Camera Agent panel */}
        <CameraFeed />

        {/* Audio Agent panel */}
        <AudioPlayer />
      </div>
    </main>
  );
}
