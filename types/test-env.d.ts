/**
 * Brings the jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`, …) into
 * the Vitest `expect` type. Referenced by every package tsconfig so colocated
 * tests are typechecked together with the source they cover.
 */
import "@testing-library/jest-dom/vitest";
