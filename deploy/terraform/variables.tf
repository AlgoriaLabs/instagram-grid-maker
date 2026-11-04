# Inputs. deploy.sh sets tenancy_ocid, region and ssh_public_key from ~/.oci/config and deploy/.secrets; override any
# other in deploy/terraform/terraform.tfvars (kept out of git).

variable "tenancy_ocid" {
  description = "Your tenancy's OCID (the tenancy line of ~/.oci/config)."
  type        = string
}

variable "region" {
  description = "Your home region, such as eu-frankfurt-1. Always Free A1 capacity exists only in the home region."
  type        = string
}

variable "oci_profile" {
  description = "The profile in ~/.oci/config to use."
  type        = string
  default     = "DEFAULT"
}

variable "compartment_ocid" {
  description = "Compartment for every resource. Empty: the tenancy's root compartment."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "Public key allowed to SSH in as ubuntu."
  type        = string
}

variable "ssh_cidr" {
  description = "Who may reach SSH. deploy.sh sets it to this computer's public IP; 0.0.0.0/0 if that fails."
  type        = string
  default     = "0.0.0.0/0"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "instagram-grid-maker"
}

variable "domain" {
  description = "Your own hostname, with an A record pointing at the VM. Empty: <ip>.sslip.io, no domain needed."
  type        = string
  default     = ""
}

variable "instance_shape" {
  description = "VM.Standard.A1.Flex (Ampere, Always Free up to 4 OCPU / 24 GB) or VM.Standard.E2.1.Micro (AMD, 1 GB)."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "ocpus" {
  description = "OCPUs for a Flex shape."
  type        = number
  default     = 1
}

variable "memory_gb" {
  description = "Memory for a Flex shape, in GB."
  type        = number
  default     = 6
}

variable "boot_volume_gb" {
  description = "Boot volume size. Always Free covers 200 GB in total."
  type        = number
  default     = 50
}

variable "availability_domain_index" {
  description = "Which availability domain (0, 1 or 2). Try another when A1 reports 'Out of host capacity'."
  type        = number
  default     = 0
}
