**English** · [한국어](배경.md)

# Why it exists — the work between the standard and the factory

The Asset Administration Shell (AAS, IEC 63278) is in place as a standard. The metamodel and API
specifications are published, and there are several open tools — editors, servers, SDKs. But the work
people hit when they put AAS into a real factory sits outside the specification. VEXPLOR AAS Studio was
built so that software takes on that work.

The evidence below was checked against the original sources on 2026-10-18. The list is at the end.

## 1. What people hit on the shop floor, and what this tool takes on

| What people hit | Evidence | In VEXPLOR AAS Studio |
|---|---|---|
| **Attaching to machines and PLCs that already run** | A review of ten years of AAS research names integration with legacy and existing systems as a key challenge that can hold back short-term adoption[1]. A Korean paper notes that applying AAS after a system is built means changing PLC and gateway firmware and the database structure[2] | Collects values from OPC UA, Modbus TCP and MQTT machines at the addresses the AID (Asset Interface Description) submodel in the AAS defines. The remote collector on a factory PC sends outward only. PLC programs are not changed |
| **Building an AAS by hand** | Without tooling every step is manual and programming-heavy[3]. Fraunhofer IOSB-INA gives manual effort and expert knowledge as the main reason brownfield adoption is still limited[4] | Start from a fully filled sample machine ("Start with a sample"), fill many values at once from value tables or a CSV equipment register. 43 rules point out what is wrong; 19 of them fix it automatically |
| **Submodel templates still being written** | In the official IDTA list, 65 of 109 template numbers have a published version; 44 are in development, review or proposal (checked 2026-10-18, counted by number)[5] | Install the published IDTA templates and each row of the value table is marked required, collected or optional, so you can see what to fill |
| **One tool per job** | Open tools split into an editor (AASX Package Explorer), servers (Eclipse BaSyx, FA³ST) and libraries (Eclipse AAS4J); field value collection means mapping tags and addresses by hand in configuration files[6][7][8] | Open, edit, check, serve via Part 2 REST, collect field values and publish via OPC UA — in one web screen |
| **Passing the standard, failing the receiver** | The Korean receiving validator (KOSMO Validator) checks its own business rules — a semantic ID allow-list, mandatory submodels, package structure. Those rules are not in the standard | Those rules run as a linter (L3) before submission. Where the standard and the receiver disagree, the conflict is shown as a policy the user decides |

## 2. This does not mean AAS is absent from factories

There are real line deployments. Bosch Rexroth's Ulm plant gives every machine and module an AAS and is
extending the same platform to other plants[9]. Seven German wire-harness companies connected product
selection through to crimping machines with AAS in a three-year project[10]. In Korea, Gyeongsangnam-do
piloted an AAS-based manufacturing operating system for the automotive parts industry[11].

Those cases report the same difficulties. The Bosch Rexroth case notes that integration work when machines
are replaced or added can take months, and that writing the AAS is the first hurdle for many users[9]. The
review concludes that adoption is still concentrated in parts of Europe, mainly Germany[1].

That connection work is what VEXPLOR AAS Studio sets out to reduce. It does not replace the AAS standard;
it makes values flow from factory machines exactly as the standard defines.

## 3. Sources (checked 2026-10-18)

1. Sakurada, de la Prieta, Leitão, "Ten Years of Asset Administration Shell: Developments, Research
   Opportunities, and Adoption Challenges", IEEE Access vol.13, 2025, DOI 10.1109/ACCESS.2025.3586716
2. J. Jeong, K. Jin, "AAS design for manufacturing data collection in a smart factory" (Korean), KIICE
   Fall Conference 2022 — https://koreascience.kr/article/CFKO202232558387331.pdf
3. Arm et al., "Automated Design and Integration of Asset Administration Shells in Components of Industry
   4.0", Sensors 21(6):2004, 2021, DOI 10.3390/s21062004
4. Heitkamp, Benndorf, "AAS Submodel Generator: Inferring Product Data from Natural Language", atp magazin
   67(1-2), 2025, DOI 10.17560/atp.v67i1-2.2773 (abstract)
5. IDTA submodel template list — https://industrialdigitaltwin.org/en/content-hub/submodels
6. Eclipse AASX Package Explorer — https://github.com/eclipse-aaspe/package-explorer
7. FA³ST Service asset connection docs — https://faaast-service.readthedocs.io/en/latest/interfaces/asset-connection.html
8. Eclipse BaSyx Java Server SDK — https://github.com/eclipse-basyx/basyx-java-server-sdk ·
   Eclipse AAS4J — https://github.com/eclipse-aas4j/aas4j
9. IoT Use Case, Bosch Rexroth Ulm plant (2026-09-04) —
   https://www.iotusecase.com/en/solution-examples/reconfigure-production-lines-flexibly
10. ARENA2036, AAS4WH results conference (2024-10-15) — https://arena2036.de/en/vws4ls/ergebnistagung/
11. HelloT, Korea–Germany "AAS standard-based smart manufacturing forum" in Changwon (2023-05-13, Korean) —
    https://hellot.net/news/article.html?no=77918

> Not affiliated with any of the tools, bodies or companies above, and not derived from their source. This
> summarises what their public documents say each tool does.
