import type { Metadata } from 'next';
import { ComparePage } from '@/components/compare/ComparePage';

export const metadata: Metadata = {
  title: 'Compare flights',
  description: 'Overlay speed, altitude, engines, propellant, Mach, dynamic pressure and more for every Starship flight on the same axes.',
};

export default function Compare() {
  return <ComparePage />;
}
