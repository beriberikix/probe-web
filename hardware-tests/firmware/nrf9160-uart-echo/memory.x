/* nRF9160: 1 MiB flash at 0, 256 KiB RAM at 0x20000000. Runs as the secure image after a full erase. */
MEMORY
{
  FLASH : ORIGIN = 0x00000000, LENGTH = 1M
  RAM : ORIGIN = 0x20000000, LENGTH = 256K
}
