const mapConfig = document.getElementById("map-config");
const listingJson = document.getElementById("listing-json");

if (mapConfig && listingJson && document.getElementById("map")) {
  const mapToken = mapConfig.dataset.mapToken;
  const listing = JSON.parse(listingJson.textContent);

  mapboxgl.accessToken = mapToken;

  const map = new mapboxgl.Map({
    container: "map",
    center: listing.geometry.coordinates,
    style: "mapbox://styles/mapbox/streets-v12",
    zoom: 9,
  });

  new mapboxgl.Marker({ color: "red" })
    .setLngLat(listing.geometry.coordinates)
    .setPopup(
      new mapboxgl.Popup({ offset: 25 }).setHTML(
        `<h4>${listing.title}</h4><p>${listing.location}, ${listing.country}</p>`
      )
    )
    .addTo(map);
}