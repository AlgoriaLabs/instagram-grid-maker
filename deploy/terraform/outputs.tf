# What deploy.sh reads back after apply.

output "public_ip" {
  value = oci_core_instance.app.public_ip
}

output "hostname" {
  value = local.hostname
}

output "origin" {
  description = "The service's public HTTPS origin: PUBLIC_ORIGIN, and the address registered in Stellar 8004."
  value       = "https://${local.hostname}"
}

output "ssh_user" {
  value = "ubuntu"
}
