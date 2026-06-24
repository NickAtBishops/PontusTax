from pontus_tax.verify import address_matches, assess_match, owner_matches


def test_owner_fuzzy_contains():
    assert owner_matches("EHC Palm Beach", "PONTUS EHC PALM BEACH LLC")
    assert owner_matches(None, "PONTUS WHATEVER HOLDINGS")  # PONTUS is enough
    assert not owner_matches("EHC Palm Beach", "SMITH FAMILY TRUST")


def test_address_normalization():
    assert address_matches("950 Evernia St", "950 EVERNIA STREET")
    assert address_matches("1800 NW 49th St", "1800 NORTHWEST 49TH STREET")
    assert not address_matches("950 Evernia St", "952 Evernia St")


def test_seller_exception_account_plus_address():
    # §6.1: owner doesn't match but parcel AND address do → proceed MEDIUM
    verdict = assess_match(
        ["T815151"], "Pontus EHC Pinellas LLC", "2180 49th St N",
        {
            "owner_on_page": "OLD SELLER PROPERTIES INC",
            "situs_address_on_page": "2180 49TH ST N",
            "parcel_or_account_on_page": "T815151",
        },
    )
    assert verdict.matched
    assert verdict.owner_mismatch
    assert verdict.confidence_hint == "HIGH"  # account + address both exact


def test_wrong_record_rejected():
    verdict = assess_match(
        ["T815151"], "Pontus EHC Pinellas LLC", "2180 49th St N",
        {
            "owner_on_page": "SOMEONE ELSE",
            "situs_address_on_page": "999 OTHER RD",
            "parcel_or_account_on_page": "X000001",
        },
    )
    assert not verdict.matched
