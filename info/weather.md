# Weather

Say these to Claude, or type them. Claude changes the Earth map while it answers, and says what's now on screen. Similar wording works too.

**"What's today's wind forecast?"**, **"Show ocean currents"**, **"Show tomorrow's temperatures over Europe"**  
Shows the Earth map (show_earth), with any of these:

- **mode:** air, ocean, chem, particulates, space or bio
- **overlay:** the color layer, such as temp, relative_humidity, precip_3hr, uv_index, sea_surface_temp, significant_wave_height, no2 or pm2.5
- **animation:** wind, currents or primary_waves
- **height:** surface, 1000hPa, 850hPa, 700hPa, 500hPa, 250hPa, 70hPa or 10hPa
- **time:** current, or a UTC time, in 3-hour steps
- **center:** longitude, latitude and zoom (900 the globe, 2500 a continent, 5000 a country, 10000 a state)
- **projection:** orthographic (the globe), equirectangular, winkel3 and others
- **location:** a spotlight marker at a longitude and latitude
- **annotation:** fires or none, and **grid** and **animate**, on or off

**"Close the map"**  
Closes the Earth map (hide_earth).

## Links

The map follows the page's URL hash, so any view can be linked:  
`#geoview=earth&earth=current/wind/surface/level/orthographic=-67.66,31.71,913`
