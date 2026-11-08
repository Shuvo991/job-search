"use client";

import { useState } from "react";
import { controlClass, hintClass, labelClass } from "@/components/ui/styles";
import type { CountryOption, PlaceOption } from "@/lib/jobs/repository";

/**
 * Country and City selectors. The City list only holds cities of the chosen country, and picking a
 * different country clears the city. Without JavaScript the form still works: choose a country,
 * press "Apply filters", and the city list for that country appears.
 */
export function LocationFilter({
  countries,
  regions,
  initialCountry,
  initialCity,
}: {
  countries: CountryOption[];
  regions: PlaceOption[];
  initialCountry: string | undefined;
  initialCity: string | undefined;
}) {
  const [country, setCountry] = useState(initialCountry ?? "");
  const [city, setCity] = useState(initialCity ?? "");

  const selected = countries.find((option) => option.name === country);
  // A country picked from the URL that has no open jobs right now is still shown, so the filter is visible.
  const unlisted = country !== "" && selected === undefined && !regions.some((region) => region.name === country);
  const cities = selected?.cities ?? [];
  const cityMissing = city !== "" && !cities.some((option) => option.name === city);
  const cityDisabled = selected === undefined && !(unlisted && city !== "");

  return (
    <>
      <div>
        <label htmlFor="filter-country" className={labelClass}>
          Country
        </label>
        <select
          id="filter-country"
          name="country"
          value={country}
          onChange={(event) => {
            setCountry(event.target.value);
            setCity("");
          }}
          className={`${controlClass} mt-1`}
        >
          <option value="">Any country</option>
          {countries.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name} ({option.count})
            </option>
          ))}
          {regions.length > 0 ? (
            <optgroup label="Regions">
              {regions.map((option) => (
                <option key={option.name} value={option.name}>
                  {option.name === "Worldwide" ? "Worldwide remote" : "Europe-wide remote"} ({option.count})
                </option>
              ))}
            </optgroup>
          ) : null}
          {unlisted ? <option value={country}>{country} (0)</option> : null}
        </select>
      </div>

      <div>
        <label htmlFor="filter-city" className={labelClass}>
          City
        </label>
        <select
          id="filter-city"
          name="city"
          value={city}
          disabled={cityDisabled}
          aria-describedby="filter-city-hint"
          onChange={(event) => setCity(event.target.value)}
          className={`${controlClass} mt-1 disabled:bg-neutral-100 disabled:text-neutral-700`}
        >
          <option value="">{cityDisabled ? "Pick a country first" : "Any city"}</option>
          {cities.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name} ({option.count})
            </option>
          ))}
          {cityMissing ? <option value={city}>{city} (0)</option> : null}
        </select>
        <p id="filter-city-hint" className={hintClass}>
          Only cities in the chosen country.
        </p>
      </div>
    </>
  );
}
