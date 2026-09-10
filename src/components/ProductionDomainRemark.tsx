import React, { useState } from 'react'
import { API_BASE } from '../services/apiBase'

export default function ProductionDomainRemark() {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-label="Show production public domain"
        aria-expanded={open}
        aria-controls="production-domain-remark"
        title="Production public domain"
        className={`flex h-8 w-8 items-center justify-center rounded border transition-colors ${
          open
            ? 'border-blue-500 bg-blue-600/20 text-blue-300'
            : 'border-[#374151] bg-transparent text-[#8b949e] hover:border-[#6b7280] hover:text-white'
        }`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
          <path d="M7.5 8h9M7.5 12h9M7.5 16h9" />
        </svg>
      </button>
      {open && (
        <div
          id="production-domain-remark"
          role="note"
          className="absolute right-0 top-full z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-[#30363d] bg-[#161b22] p-3 shadow-xl"
        >
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8b949e]">
            Production public domain
          </div>
          <a
            href={API_BASE}
            target="_blank"
            rel="noreferrer"
            className="block break-all text-sm text-blue-400 hover:text-blue-300"
          >
            {API_BASE}
          </a>
        </div>
      )}
    </div>
  )
}
