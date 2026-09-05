// Grand Prix mode: lap racing at real-world circuit locations, on whatever
// actual roads OSM has near them — not the official private track geometry
// (roads.js has no routing graph to follow a prescribed racing line anyway,
// see bots.js), just a real start/finish point at a famous circuit's
// location, same spirit as picker.js's FAMOUS_ROUTES presets. `heading` is
// the approximate direction of the front straight in degrees (0 = north),
// used to spawn the car facing the right way and to draw the start/finish
// line across the road. `lapKm` is a rough real lap length, used as the
// distance threshold for counting a lap (see drive.js).
export const GRAND_PRIX_CIRCUITS = [
  { id: "monaco", name: "🇲🇨 Monaco", lat: 43.7347, lng: 7.4206, heading: 70, lapKm: 3.34 },
  { id: "silverstone", name: "🇬🇧 Silverstone", lat: 52.0786, lng: -1.0169, heading: 90, lapKm: 5.89 },
  { id: "spa", name: "🇧🇪 Spa-Francorchamps", lat: 50.4372, lng: 5.9714, heading: 45, lapKm: 7.00 },
  { id: "monza", name: "🇮🇹 Monza", lat: 45.6156, lng: 9.2811, heading: 0, lapKm: 5.79 },
  { id: "suzuka", name: "🇯🇵 Suzuka", lat: 34.8431, lng: 136.5410, heading: 180, lapKm: 5.81 },
  { id: "interlagos", name: "🇧🇷 Interlagos", lat: -23.7036, lng: -46.6997, heading: 90, lapKm: 4.31 },
  { id: "cota", name: "🇺🇸 Circuit of the Americas", lat: 30.1328, lng: -97.6411, heading: 170, lapKm: 5.51 },
  { id: "redbullring", name: "🇦🇹 Red Bull Ring", lat: 47.2197, lng: 14.7647, heading: 90, lapKm: 4.32 },
  { id: "nurburgring-gp", name: "🇩🇪 Nürburgring GP", lat: 50.3356, lng: 6.9475, heading: 0, lapKm: 5.15 },
  { id: "albertpark", name: "🇦🇺 Albert Park", lat: -37.8497, lng: 144.9680, heading: 90, lapKm: 5.28 },
];

export const LAP_OPTIONS = [1, 3, 5, 10];
