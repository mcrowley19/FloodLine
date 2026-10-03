# Notes for slides: front-line flood response bottlenecks

Research notes (October 2026). Focus is Ireland (OPW gauges, Storm Chandra), plus the major UK, German and Spanish inquiries.

## The six bottlenecks

### 1. The warning arrives, but nobody turns it into action
The most damning finding across every inquiry.

- **Germany, Ahr valley, 2021:** a state parliamentary inquiry wrote a report of about 2,100 pages. It found that warnings came early enough to act, but the county and state agencies never turned them into instructions, evacuations or public alerts. The crisis teams were activated far too late.
- **Valencia, 2024:** Spain's weather agency issued a red alert at least 8 hours before the flash floods. The public alert went out at 8pm, when people were already driving home. The military emergency unit was in place but had no legal mandate to act.
- **Takeaway:** the forecast was rarely the weak link. The step from "risk is high" to "here is what we do now" was.

### 2. Warnings cover areas that are too big, and nobody owns them
- RTÉ's analysis ([Ireland can predict weather, why can't it warn of floods?](https://www.rte.ie/news/clarity/2026/0412/1567613-weather-flooding-clarity/)) points out that Ireland has more than 1,000 monitoring points but no single agency that delivers flood warnings. Met Éireann does the weather, the OPW does the rivers, and councils fill the gaps. Localised warnings like the UK's could take up to 10 years.
- During Chandra, the national director of Fire and Emergency Management said South Dublin was caught "by surprise". Councils had been sent high flood-risk notices in advance, but there was no rain warning for Dublin.
- Climatologist John Sweeney: "Our obsession with county boundaries" stops warnings being issued per river catchment.
- The Taoiseach and the government have since backed reform and more localised warnings ([TheJournal](https://www.thejournal.ie/weather-warning-system-taoiseach-flooding-6945268-Feb2026/), [RTÉ](https://www.rte.ie/news/2026/0201/1556235-politics-weather/), [RTÉ warning row](https://www.rte.ie/news/politics/2026/0128/1555649-weather-warning-row/)).

### 3. The official forecasting service is slow to arrive
- The national flood forecasting service was decided in 2016. Its own 2020 presentation set out a plan of national and catchment-level products, sent to a named weather-and-flood liaison manager in each council ([Met Éireann slides](https://assets.gov.ie/180251/13deeff8-fc07-469e-9f1a-dae92f5a5c0c.pdf)).
- In 2025 only €1.9m of a €4.3m budget was spent, and the pace was described as "glacial". The project is moving to the Office of Emergency Planning.
- In September 2026 the Cabinet heard plans to improve flood forecasting and warnings, with no completion date ([TheJournal](https://www.thejournal.ie/flooding-cabinet-7156118-Sep2026/), [Irish Examiner](https://www.irishexaminer.com/news/politics/arid-41908327.html)).

### 4. There's no single shared picture of what's happening
- After Storm Babet, the Lincolnshire responders' first debrief said the top lesson was "improving the speed and accuracy of information and intelligence to have single versions of what is happening and the level of risk." The public also didn't know who to report flooding to. (Quoted from a search excerpt; the PDF blocked direct reading: [report](https://lincolnshire.moderngov.co.uk/documents/s66320/05A%20Storms%20Babet%20and%20Henk%20Report.pdf).)
- The UK's Pitt Review of the 2007 floods said much the same 18 years ago ([RUSI](https://www.rusi.org/publication/learning-lessons-2007-floods-final-recommendations-pitt-review)).
- Research on disaster response keeps citing late recognition of impacts, fragmented or contradictory information, and slow decision chains ([arXiv review](https://arxiv.org/html/2508.16669)).

### 5. Scarce resources and tired crews
- **Sandbags:** they are slow to fill, at about 12 per hour per the Cornwall community flood forum's volunteer guide ([guide](https://www.cornwallcommunityfloodforum.org.uk/wp-content/uploads/2019/05/Community-Volunteer-Booklet-Sandbags_WEB.pdf)). During Chandra, Dublin City Council had limited supplies and sent them only to places at immediate risk.
- **Fatigue:** the national emergency coordination group warned that crews had been working hard for over a week and were "starting to get fatigued", so councils needed to back each other up ([Irish Times live](https://www.irishtimes.com/environment/2026/02/03/live-met-eireann-weather-warnings-rainfall-flooding-ireland/)).
- **Uneven coverage:** in Storm Babet, agencies concentrated on Midleton while nearby Mogeely relied on volunteers. In Chandra, volunteers and Civil Defence did a lot of the evacuations, welfare checks and sandbag runs ([Civil Defence](https://www.civildefence.ie/storm-chandra-flood-relief-efforts/)). The Climate Change Advisory Council warned that community effort "cannot act as a substitute" for planned investment ([Irish Examiner](https://www.irishexaminer.com/news/arid-41916784.html)).

### 6. Plans and hazard maps don't fit what actually happens
- More than a year after Babet, Cork County Council's flood emergency plan for Midleton was still a draft ([Irish Examiner](https://www.irishexaminer.com/news/munster/arid-41506028.html)).
- In the Ahr valley, 75% of deaths happened outside the mapped hazard zones. The gauge forecast said 5.7 m and the river peaked at about 10.2 m. 29% of people affected got no warning at all ([NHESS 2025](https://nhess.copernicus.org/articles/25/581/2025/)). The authors' main recommendation is impact forecasting: telling responders how deep and fast the water will be, and where, not just the river level.
- The long-term structural fix is also stuck. 30 of 54 Irish flood relief schemes are still at preliminary design, and Enniscorthy flooded again ([Irish Times, 3 Oct 2026](https://www.irishtimes.com/environment/climate-crisis/2026/10/03/were-in-limbo-enniscorthy-businesses-feel-defenceless-after-latest-flood/)).

## What this means for FloodLine

The research points at the gap `decision.py` already targets: turning a forecast into an action.

- **Warn per gauge or catchment, not per county.** That's the most consistent complaint in the Chandra coverage.
- **Keep the triggers and task lists.** The newsvendor sandbag trigger and the lead-time list (rest centre, public warning, culverts, collection points) answer the "nobody acted" failure in the Ahr and Valencia inquiries directly.
- **Use users' real limits as inputs.** Sandbag stock, fill rate and crew-hours (plus fatigue) are the constraints councils actually hit.
- **Aim at the council's liaison manager.** The national plan already defines this role as the person who receives flood alerts. That's the natural user.
- **Be honest about uncertainty.** The Ahr forecast was off by almost half, so show forecast ranges and say plainly when a river is beyond anything in the training data.
- **Make it a shared view.** One screen that the council, Civil Defence and volunteer groups all see is the "single version of what is happening" Lincolnshire asked for.

## Caveats
- A few sources (Lincolnshire, PreventionWeb, ScienceDirect) blocked direct fetching, so those points rest on search excerpts.

## Other sources
- [Valencia 2024: failures in early warning, action, coordination and localisation (PreventionWeb)](https://www.preventionweb.net/news/2024-spain-floods-failures-early-warning-action-coordination-and-localisation)
- [Ahr valley inquiry overview (D+C)](https://www.dandc.eu/en/article/flooding-july-2021-could-have-been-less-disastrous-if-authorities-had-learned-past-and)
- [Aware but not prepared: situational awareness in the 2021 German flood (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S2212420923004168)
- [Storm Chandra live coverage, Enniscorthy (Irish Times)](https://www.irishtimes.com/environment/2026/01/27/live-updates-storm-chandra-ireland-wind-warnings/)
- [Midleton residents: "Nothing is stopping a flood" (RTÉ)](https://www.rte.ie/news/munster/2026/0207/1557173-midleton-flooding/)
