"use client";

import { Loader2, MapPin, Search, X } from "lucide-react";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type { PlacesPrediction } from "@/lib/outstation/types";

const SESSION_TOKEN = Math.random().toString(36).slice(2);

type PlacesAutocompleteInputProps = {
  disabled?: boolean;
  onSelect: (prediction: PlacesPrediction) => void;
  placeholder?: string;
  value?: string;
};

export function PlacesAutocompleteInput({
  disabled,
  onSelect,
  placeholder = "Search destination…",
  value,
}: PlacesAutocompleteInputProps) {
  const [inputValue, setInputValue] = useState(value ?? "");
  const [predictions, setPredictions] = useState<PlacesPrediction[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value !== undefined) {
      startTransition(() => {
        setInputValue(value);
      });
    }
  }, [value]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const fetchPredictions = useCallback(async (query: string) => {
    if (query.trim().length < 2) {
      setPredictions([]);
      setOpen(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/admin/outstation/places-autocomplete", window.location.origin);
      url.searchParams.set("input", query);
      url.searchParams.set("sessiontoken", SESSION_TOKEN);
      const response = await fetch(url.toString());
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        predictions?: PlacesPrediction[];
      };

      if (!response.ok || !payload.predictions) {
        setError(payload.message ?? "Could not fetch suggestions.");
        setPredictions([]);
      } else {
        setPredictions(payload.predictions);
        setOpen(payload.predictions.length > 0);
      }
    } catch {
      setError("Could not reach the suggestions service.");
      setPredictions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const query = event.target.value;
    setInputValue(query);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchPredictions(query), 300);
  }

  function handleSelect(prediction: PlacesPrediction) {
    setInputValue(prediction.description);
    setPredictions([]);
    setOpen(false);
    onSelect(prediction);
  }

  function handleClear() {
    setInputValue("");
    setPredictions([]);
    setOpen(false);
    setError(null);
  }

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
        <input
          className="h-11 w-full rounded-2xl border border-[#DDE6F1] bg-white/95 pl-9 pr-9 text-sm font-semibold text-phx-ink shadow-sm placeholder:font-normal placeholder:text-phx-ink-faint focus:border-phx-accent focus:outline-none focus:ring-2 focus:ring-[#FED7AA] disabled:opacity-60"
          disabled={disabled}
          onChange={handleChange}
          onFocus={() => predictions.length > 0 && setOpen(true)}
          placeholder={placeholder}
          type="text"
          value={inputValue}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-phx-accent" />
        ) : inputValue ? (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 text-phx-ink-faint hover:text-phx-ink-soft"
            onClick={handleClear}
            tabIndex={-1}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-1 text-xs font-semibold text-[#B91C1C]">{error}</p>
      ) : null}

      {open && predictions.length > 0 ? (
        <ul className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-64 overflow-y-auto rounded-2xl border border-[#DDE6F1] bg-white shadow-[0_8px_32px_rgba(15,23,42,0.12)]">
          {predictions.map((prediction) => (
            <li key={prediction.placeId}>
              <button
                className="flex w-full items-start gap-2.5 px-4 py-3 text-left text-sm transition-colors hover:bg-phx-accent-soft focus:bg-phx-accent-soft focus:outline-none"
                onClick={() => handleSelect(prediction)}
                type="button"
              >
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-phx-accent" />
                <span className="font-semibold text-phx-ink">{prediction.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
