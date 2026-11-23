package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class FrostRefreshTest {
    private fun refreshesInASecond(hz: Double): Int {
        val cadence = StripCadence(FrostRefresh.PAGE_STRIP_HZ)
        return (0 until hz.toInt()).count { frame -> cadence.offer(Math.round(frame * 1000.0 / hz)) }
    }

    @Test
    fun aStripOverAPageRefreshesAboutSixtyTimesASecondWhateverTheScreensRate() {
        assertEquals(60.0, refreshesInASecond(60.0).toDouble(), 1.0)
        assertEquals(60.0, refreshesInASecond(90.0).toDouble(), 1.0)
        assertEquals(60.0, refreshesInASecond(120.0).toDouble(), 1.0)
        assertEquals(60.0, refreshesInASecond(144.0).toDouble(), 1.0)
    }

    @Test
    fun aStripAfterAQuietSpellRefreshesAtOnceWithoutABurst() {
        val cadence = StripCadence(FrostRefresh.PAGE_STRIP_HZ)
        assertEquals(true, cadence.offer(0L))
        assertEquals(true, cadence.offer(5_000L))
        assertEquals("the quiet spell doesn't buy a run of back-to-back refreshes", false, cadence.offer(5_008L))
        assertEquals(true, cadence.offer(5_017L))
    }

    @Test
    fun eachFrostIsNamedInTheLogByItsNameOrItsSourceVariantAndNumber() {
        assertEquals("deck-plus", FrostRefresh.label(name = "deck-plus", source = "deck", variant = "bar", number = 3))
        assertEquals("deck/bar #3", FrostRefresh.label(name = null, source = "deck", variant = null, number = 3))
        assertEquals("-/sheet #1", FrostRefresh.label(name = "", source = null, variant = "sheet", number = 1))
    }
}
